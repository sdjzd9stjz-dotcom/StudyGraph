// 巡检 A–F 落库实测（SG-SUP-017 §3.3 / §5 第 5 项）。
//
// 为什么必须落库跑：巡检的判据按 `reviewedBy` 分成三支（自动核实的要过完整 T1、
// 人工认可的只查引文、待审的只查引文）。只对 `assessIntegrity()` 做单测，
// 证明不了「库里那张卡真的按它那一支判了」——分支选错时单测照样绿。
//
// 隔离设计（2026-11-20 修）：
//   第一版所有用例共用一个画布/来源，结果两个用例互相污染 ——
//   ① G 改共享 span 的文本，把 A/C 一起打成 TEXT_MISMATCH；
//   ② 同一画布内 (canvasId,name) 唯一，只好给概念名加「（用例X）」后缀，
//      而 T1 要求名称出现在定义里，加了后缀的 A 就被判 UNSUPPORTED_DEFINITION。
//   现在是：每个用例一套独立的 Canvas + Node + Source + 页文本 + Span。
//   概念名保持原样，测的才是真正的判据。
//
// 用法：node scripts/verify-integrity-cases.mjs
import path from 'node:path'

process.chdir(path.resolve(import.meta.dirname, '..'))
process.loadEnvFile('.env')

const { prisma } = await import('../packages/db/src/index.ts')
const { createObjectStore } = await import('../apps/api/src/storage/object-store.ts')
const { writePageTexts } = await import('../apps/api/src/storage/page-text.ts')
const { checkConceptCitations } = await import('../apps/api/src/spans/citation-integrity.ts')

const store = createObjectStore({
  endpoint: process.env.S3_ENDPOINT,
  bucket: process.env.S3_BUCKET,
  region: process.env.S3_REGION,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
})
if (store.kind === 'none') throw new Error('对象存储未配置，巡检无法读取原文')

const PAGE_TEXT = '导数是函数的变化率。高阶导数是二阶和二阶以上的导数的统称。鲸鱼是一种行星。'
const QUOTE_T1 = '高阶导数是二阶和二阶以上的导数的统称。'
const QUOTE_WHALE = '鲸鱼是一种行星。'

const pageOf = (quote) => {
  const start = PAGE_TEXT.indexOf(quote)
  if (start < 0) throw new Error(`用例引文不在页文本里：${quote}`)
  return { start, end: start + quote.length }
}

const owner = await prisma.user.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })

// 每个用例一套独立环境；`spanText` 默认取页内该引文的原文，
// 传了 `spanOffset` 则改动区间（用于制造"span 与原文页不一致"）。
async function seedCase(testCase) {
  const canvas = await prisma.canvas.create({
    data: { ownerId: owner.id, title: `017 巡检用例 ${testCase.id}` },
  })
  const node = await prisma.node.create({ data: { canvasId: canvas.id, type: 'SOURCE', params: {} } })
  const source = await prisma.source.create({
    data: {
      nodeId: node.id,
      kind: 'PPTX',
      filename: `integrity-${testCase.id}.pptx`,
      mimeType: 'application/vnd.ms-powerpoint',
      pageCount: 1,
    },
  })
  await writePageTexts(store, canvas.id, source.id, [{ page: 1, region: 'SLIDE', text: PAGE_TEXT }])

  const { start, end } = pageOf(testCase.spanQuote ?? testCase.quote)
  const span = await prisma.span.create({
    data: {
      sourceId: source.id,
      page: 1,
      region: 'SLIDE',
      charStart: start,
      charEnd: end,
      text: testCase.spanText ?? PAGE_TEXT.slice(start, end),
    },
  })

  // 守卫强制顺序：先以未验证态建卡 → 挂引文 → 再置目标状态
  const concept = await prisma.concept.create({
    data: {
      canvasId: canvas.id,
      name: testCase.seed.name,
      definition: testCase.seed.definition,
      status: 'UNVERIFIED',
    },
  })
  await prisma.conceptCitation.create({
    data: { conceptId: concept.id, spanId: span.id, isPrimary: true, quote: testCase.quote },
  })
  await prisma.concept.update({
    where: { id: concept.id },
    data: {
      status: testCase.seed.status,
      reviewedBy: testCase.seed.reviewedBy,
      reviewedAt: testCase.seed.reviewedBy ? new Date() : null,
      reviewDecision: testCase.seed.reviewedBy ? 'ACCEPT' : null,
    },
  })

  return { canvasId: canvas.id, conceptId: concept.id }
}

const cases = [
  {
    id: 'A',
    desc: '自动 VERIFIED + 引文对 + T1 全过',
    seed: { name: '高阶导数', definition: QUOTE_T1, status: 'VERIFIED', reviewedBy: null },
    quote: QUOTE_T1,
    expect: { status: 'VERIFIED', reason: null },
  },
  {
    id: 'B',
    desc: '自动 VERIFIED + 引文对 + 定义与引文无关（鲸鱼）',
    seed: { name: '鲸鱼', definition: '鲸鱼是一种行星。', status: 'VERIFIED', reviewedBy: null },
    quote: QUOTE_WHALE,
    expect: { status: 'UNVERIFIED', reason: 'UNSUPPORTED_DEFINITION' },
  },
  {
    id: 'C',
    desc: '人工 ACCEPT + 引文对 + 定义是合理转述（不该按 T1 误杀）',
    seed: { name: '高阶导数', definition: '高阶导数是指二阶及以上的导数。', status: 'VERIFIED', reviewedBy: owner.id },
    quote: QUOTE_T1,
    expect: { status: 'VERIFIED', reason: null },
  },
  {
    id: 'D',
    desc: '人工 ACCEPT + 引文伪造（原文里查不到）',
    seed: { name: '高阶导数', definition: '高阶导数是指二阶及以上的导数。', status: 'VERIFIED', reviewedBy: owner.id },
    quote: '高阶导数是指二阶导数。',
    spanQuote: QUOTE_T1,
    expect: { status: 'UNVERIFIED', reason: 'TEXT_MISMATCH' },
  },
  {
    id: 'E',
    desc: 'PENDING_REVIEW + 引文对 + 定义不达标（不该降级）',
    seed: { name: '鲸鱼', definition: '鲸鱼是一种大型哺乳动物。', status: 'PENDING_REVIEW', reviewedBy: null },
    quote: QUOTE_WHALE,
    expect: { status: 'PENDING_REVIEW', reason: null },
  },
  {
    id: 'F',
    desc: 'PENDING_REVIEW + 引文伪造',
    seed: { name: '鲸鱼', definition: '鲸鱼是一种大型哺乳动物。', status: 'PENDING_REVIEW', reviewedBy: null },
    quote: '鲸鱼会飞。',
    spanQuote: QUOTE_WHALE,
    expect: { status: 'UNVERIFIED', reason: 'TEXT_MISMATCH' },
  },
  {
    id: 'G',
    desc: 'span 存储文本与原文页该区间不一致（TEXT_MISMATCH 独立通道）',
    seed: { name: '高阶导数', definition: QUOTE_T1, status: 'VERIFIED', reviewedBy: null },
    quote: QUOTE_T1,
    spanQuote: QUOTE_T1,
    spanText: '高阶导数是二阶导数的统称。', // 与 PAGE_TEXT 该区间不同
    expect: { status: 'UNVERIFIED', reason: 'TEXT_MISMATCH' },
  },
]

const rows = []
let failed = 0
for (const testCase of cases) {
  const seeded = await seedCase(testCase)
  const report = await checkConceptCitations({ prisma, objectStore: store }, seeded.canvasId)
  const after = await prisma.concept.findUniqueOrThrow({ where: { id: seeded.conceptId } })
  const failure = report.failures.find((f) => f.conceptId === seeded.conceptId)
  const statusOk = after.status === testCase.expect.status
  const reasonOk = testCase.expect.reason === null ? !failure : failure?.reason === testCase.expect.reason
  const ok = statusOk && reasonOk
  if (!ok) failed += 1
  rows.push({
    case: testCase.id,
    desc: testCase.desc,
    before: testCase.seed.status,
    after: after.status,
    expect: testCase.expect.status,
    reason: failure?.reason ?? null,
    expectReason: testCase.expect.reason,
    checked: report.checked,
    unverifiable: report.unverifiableSources.length,
    ok,
  })
}

console.log('\n巡检 A–F 落库实测（每个用例独立画布/来源/页文本）\n')
console.table(rows)
console.log(JSON.stringify({ cases: rows.length, passed: rows.length - failed, failed }, null, 2))

await prisma.$disconnect()
if (failed > 0) {
  console.error(`\n❌ ${failed}/${rows.length} 个用例不符合预期`)
  process.exit(1)
}
console.log(`\n✅ ${rows.length}/${rows.length} 个用例符合预期`)
