// SG-SUP-015 收口跑批：受控材料 → 全链路 → 产物完整性 / 纯标题 / 三态落库数。
//
// 为什么单独一份脚本而不复用 run-011：那十份课件是冻结的验收材料，
// 且 011 的账本是一次性写入（wx 模式），不能重跑。这里用一份**专门设计**的
// 小材料，每一页对应一个已知答案，四页就能同时回答三个问题：
//
//   §3.4 第 8 项  产物里有没有 quote / spanText / classifierVersion（断言，不是查询）
//   §3.4 第 4 项  纯标题页「指数函数练习目录」不许进 T1/T2，也不许产卡
//   §3.4 第 10 项 VERIFIED / PENDING_REVIEW / UNVERIFIED 的真实落库数
//
// 用法：
//   DEEPSEEK_API_KEY=... node scripts/run-015-controlled.mjs
//   DEEPSEEK_API_KEY=... node scripts/run-015-controlled.mjs --verify-only <canvasId>
//
// 密钥只从进程环境读，不落盘、不打印。
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

process.chdir(path.resolve(import.meta.dirname, '..'))
process.loadEnvFile('.env')

const { prisma } = await import('../packages/db/src/index.ts')
const { registerBuiltinExecutors } = await import('../apps/api/src/nodes/executors/index.ts')
const { executeNode } = await import('../apps/api/src/nodes/execute.ts')
const { createObjectStore } = await import('../apps/api/src/storage/object-store.ts')
const { createGateway } = await import('../apps/api/src/llm/gateway.ts')
const { checkConceptCitations } = await import('../apps/api/src/spans/citation-integrity.ts')
const { CLASSIFIER_VERSION } = await import('../apps/api/src/spans/claim-support.ts')

// 材料列表：默认是受控小材料；给了 --materials 就按行读文件路径，逐个跑同一条链。
const materialsIndex = process.argv.indexOf('--materials')
const DEFAULT_FIXTURE = path.resolve('.tmp-backup/fixtures/controlled-012.pptx')
const MATERIALS =
  materialsIndex === -1
    ? [DEFAULT_FIXTURE]
    : fs
        .readFileSync(process.argv[materialsIndex + 1], 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => path.resolve(line))
const TITLE_PAGE_PREFIX = process.env.TITLE_PAGE_PREFIX ?? '指数函数练习目录'
const LEDGER = process.env.RUN_015_LEDGER ?? 'docs/交付/实调证据-015-受控材料.jsonl'

const verifyOnlyIndex = process.argv.indexOf('--verify-only')
const verifyOnlyCanvas = verifyOnlyIndex === -1 ? null : process.argv[verifyOnlyIndex + 1]

const fail = (message, detail) => {
  console.error(`\n❌ ${message}`)
  if (detail !== undefined) console.error(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2))
  process.exitCode = 1
  throw Object.assign(new Error(message), { detail })
}

async function inspectCanvas(canvasId, { ledger }) {
  const artifacts = await prisma.artifact.findMany({
    where: { node: { canvasId } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, kind: true, structured: true, nodeId: true },
  })
  const extractArtifacts = artifacts.filter((a) => a.structured?.conceptClaims)
  const allClaims = extractArtifacts.flatMap((a) =>
    (a.structured.conceptClaims.claims ?? []).map((claim) => ({
      ...claim,
      artifactId: a.id,
      classifierVersion: claim.classifierVersion ?? a.structured.conceptClaims.classifierVersion,
    })),
  )

  const completable = allClaims.filter((c) => c.status !== 'UNVERIFIED' || c.quote)
  const missing = {
    quote: completable.filter((c) => !c.quote || !String(c.quote).trim()),
    spanText: completable.filter((c) => !c.spanText || !String(c.spanText).trim()),
    classifierVersion: completable.filter(
      (c) => !c.classifierVersion || String(c.classifierVersion).trim().length === 0,
    ),
    similarity: completable.filter((c) => typeof c.similarity !== 'number'),
    lengthRatio: completable.filter((c) => typeof c.lengthRatio !== 'number'),
  }

  const report = {
    event: 'artifact-completeness',
    canvasId,
    extractArtifacts: extractArtifacts.length,
    claims: allClaims.length,
    byStatus: allClaims.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {}),
    fields: {
      quote: completable.length - missing.quote.length,
      spanText: completable.length - missing.spanText.length,
      classifierVersion: completable.length - missing.classifierVersion.length,
      similarity: completable.length - missing.similarity.length,
      lengthRatio: completable.length - missing.lengthRatio.length,
      total: completable.length,
    },
    classifierVersions: [...new Set(allClaims.map((c) => c.classifierVersion))].filter(Boolean),
    expectedClassifierVersion: CLASSIFIER_VERSION,
    missingSamples: Object.fromEntries(
      Object.entries(missing).map(([key, list]) => [
        key,
        list.slice(0, 3).map((c) => ({ name: c.name, status: c.status, quote: c.quote })),
      ]),
    ),
  }
  if (ledger) ledger(report)
  return { report, artifacts, allClaims, extractArtifacts }
}

if (verifyOnlyCanvas) {
  const { report } = await inspectCanvas(verifyOnlyCanvas, { ledger: null })
  console.log(JSON.stringify(report, null, 2))
  await prisma.$disconnect()
  process.exit(process.exitCode ?? 0)
}

const key = process.env.DEEPSEEK_API_KEY?.trim()
if (!key) fail('缺少 DEEPSEEK_API_KEY（只从进程环境读）')
if (MATERIALS.length === 0) fail('材料列表为空')
for (const file of MATERIALS) {
  if (!fs.existsSync(file)) fail(`测试材料不存在：${file}，先跑 scripts/fixtures/make-pptx-fixture.mjs`)
}

fs.mkdirSync(path.dirname(LEDGER), { recursive: true })
// wx：账本已存在就拒绝执行，绝不覆盖历史证据
const ledgerFd = fs.openSync(LEDGER, 'wx')
const ledger = (event) => {
  const line = JSON.stringify(event)
  fs.writeSync(ledgerFd, `${line}\n`)
  fs.fsyncSync(ledgerFd)
  console.log(line)
}

let totalIn = 0
let totalOut = 0
const gateway = createGateway({
  resolveApiKey: async (provider) => (provider === 'deepseek' ? key : null),
  fetchImpl: async (url, init) => {
    if (!String(url).startsWith('https://api.deepseek.com/')) throw new Error(`非授权端点：${url}`)
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(180000) })
    if (!response.ok) {
      const body = await response.text()
      fail(`DeepSeek HTTP ${response.status}`, body.slice(0, 400))
    }
    const clone = response.clone()
    const data = await clone.json()
    const usage = data.usage
    if (usage && Number.isSafeInteger(usage.prompt_tokens)) {
      totalIn += usage.prompt_tokens
      totalOut += usage.completion_tokens ?? 0
    }
    return response
  },
})

registerBuiltinExecutors()
const objectStore = createObjectStore({
  endpoint: process.env.S3_ENDPOINT,
  bucket: process.env.S3_BUCKET,
  region: process.env.S3_REGION,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
})

// 用已有用户作为 owner（协议要求 Canvas.ownerId 外键）
const owner = await prisma.user.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })
const canvas = await prisma.canvas.create({
  data: { ownerId: owner.id, title: `015 受控材料（${new Date().toISOString()}）` },
})
ledger({ event: 'canvas', canvasId: canvas.id, ownerId: owner.id, materials: MATERIALS })

for (const material of MATERIALS) {
  const label = path.basename(material)
  let previous = null
  for (const type of ['SOURCE', 'CHUNK', 'EXTRACT', 'CARD']) {
    const params = type === 'SOURCE' ? { localPath: material } : type === 'EXTRACT' ? { batchSize: 100 } : {}
    const node = await prisma.node.create({
      data: { canvasId: canvas.id, type, params, posX: 0, posY: 0 },
    })
    if (previous) {
      await prisma.edge.create({
        data: { canvasId: canvas.id, kind: 'DERIVED_FROM', fromNodeId: previous, toNodeId: node.id, fromPort: 'out', toPort: 'in' },
      })
    }
    const run = await executeNode({ prisma, objectStore, llm: gateway, user: owner }, node.id, { dryRun: false })
    const artifact = await prisma.artifact.findFirstOrThrow({ where: { runId: run.runId } })
    ledger({
      event: 'run',
      label,
      type,
      nodeId: node.id,
      runId: run.runId,
      status: run.status,
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
    })
    if (type === 'EXTRACT') {
      const claims = artifact.structured.conceptClaims?.claims ?? []
      ledger({
        event: 'extract-summary',
        label,
        claims: claims.length,
        byStatus: claims.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {}),
      })
    }
    previous = node.id
  }
}

// ── 断言 ───────────────────────────────────────────────────────────────────
const { report, allClaims, artifacts } = await inspectCanvas(canvas.id, { ledger })

// A. 产物完整性：判定函数有几个输入，产物里就要有几个（§6 自证 3）
assert.ok(report.claims > 0, '整条链路没有产出任何 claim —— 后续断言无意义')
assert.equal(report.fields.quote, report.fields.total, `有 ${report.missingSamples.quote.length || '若干'} 条缺 quote`)
assert.equal(report.fields.spanText, report.fields.total, '有 claim 缺 spanText（无法离线重放）')
assert.equal(report.fields.classifierVersion, report.fields.total, '有 claim 缺 classifierVersion')
assert.equal(report.fields.similarity, report.fields.total, '有 claim 缺 similarity（判定输入之一）')
assert.equal(report.fields.lengthRatio, report.fields.total, '有 claim 缺 lengthRatio（判定输入之一）')
assert.deepEqual(
  report.classifierVersions,
  [report.expectedClassifierVersion],
  '产物里的 classifierVersion 与当前分类器不一致（说明产物是旧规则写的）',
)

// B. 纯标题页：不许产生任何非 UNVERIFIED 的 claim
const titleClaims = allClaims.filter((c) =>
  String(c.name ?? '').includes(TITLE_PAGE_PREFIX) || String(c.quote ?? '').includes(TITLE_PAGE_PREFIX),
)
const titleBad = titleClaims.filter((c) => c.status !== 'UNVERIFIED')
assert.equal(
  titleBad.length,
  0,
  `纯标题页产生了非 UNVERIFIED 的 claim：${JSON.stringify(titleBad.map((c) => ({ name: c.name, status: c.status, quote: c.quote })))}`,
)

// C. 对照组：定义页应当至少有 T1/T2（否则说明分类器把正确答案也拦了，属另一种失败）
const positiveClaims = allClaims.filter((c) => c.status === 'VERIFIED' || c.status === 'PENDING_REVIEW')
assert.ok(
  positiveClaims.length > 0,
  '一个正例都没通过 —— 分类器可能过严，需要人工看 reasons',
)
// D. 正例必须有 spanId（溯源是物理约束）
for (const claim of positiveClaims) {
  assert.ok(Array.isArray(claim.spanIds) && claim.spanIds.length > 0, `非 UNVERIFIED 的 claim 没有 spanId：${claim.name}`)
}

// E. 卡与 claim 对齐：CARD 产物的形状是 { cards: { cards: [...], skipped: [...] } }
// 多材料时每个材料各有一个 CARD 节点，因此要合计全部卡片产物
const cardArtifacts = artifacts.filter((a) => a.structured?.cards)
const created = cardArtifacts.flatMap((a) => a.structured.cards.cards ?? [])
const skipped = cardArtifacts.flatMap((a) => a.structured.cards.skipped ?? [])
assert.ok(cardArtifacts.length > 0, '整条链路没有产出 CARD 产物')
assert.equal(
  created.length,
  positiveClaims.length,
  `卡片数 ${created.length} 与"非 UNVERIFIED 的 claim 数" ${positiveClaims.length} 不一致`,
)
ledger({ event: 'cards', cardNodes: cardArtifacts.length, created: created.length, skipped: skipped.length })

const audit = await checkConceptCitations({ prisma, objectStore }, canvas.id)
ledger({ event: 'audit', audit })

const conceptCounts = await prisma.concept.groupBy({
  by: ['status'],
  where: { canvasId: canvas.id },
  _count: true,
})
ledger({
  event: 'completed',
  canvasId: canvas.id,
  tokensIn: totalIn,
  tokensOut: totalOut,
  conceptsByStatus: Object.fromEntries(conceptCounts.map((row) => [row.status, row._count])),
  claimsByStatus: report.byStatus,
})

fs.closeSync(ledgerFd)
await prisma.$disconnect()
console.log(`\n✅ 015 收口全部断言通过（canvas ${canvas.id}）`)
