// §3.4 第 3 项 · 写库实验 a/b/c/d + 两条降级 + 视图 0 行（SG-SUP-011 §1.3 第 3–5 条）。
//
// 为什么必须打真库：这些结论全部由数据库触发器产生。Prisma 层或单测都绕过了
// BEFORE UPDATE 触发器，绿了也证明不了「库会拦」。
//
// 用法：node scripts/verify-write-experiments.mjs <databaseUrl>
// 每条实验都打印实际 SQL 与实际返回（或实际报错），不做真值硬编码。
import path from 'node:path'

process.chdir(path.resolve(import.meta.dirname, '..'))
process.loadEnvFile('.env')

const databaseUrl = process.argv[2]
if (!databaseUrl) {
  console.error('用法：node scripts/verify-write-experiments.mjs <databaseUrl>')
  process.exit(2)
}
process.env.DATABASE_URL = databaseUrl

const { PrismaClient } = await import('../packages/db/src/index.ts')
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })

const results = []
const record = (id, sql, outcome, pass) => {
  results.push({ id, sql, outcome, pass })
  console.log(`\n[${pass ? 'PASS' : 'FAIL'}] ${id}`)
  console.log(`  SQL    : ${sql}`)
  console.log(`  实际返回: ${outcome}`)
}

// Prisma 把 PG 错误包成 ConnectorError：error.code / meta 都是 undefined，
// 真实 SQLSTATE 与 RAISE 原文只出现在 message 里（形如 code: "23514", message: "..."）。
// 必须把它们原样提出来，否则「抛了异常」不能算证据 —— 任何异常都会让这条通过。
function extractPgError(error) {
  const message = error?.message ?? String(error)
  const code = error?.meta?.code ?? error?.code ?? /code:\s*"([0-9A-Z]+)"/.exec(message)?.[1] ?? ''
  const pgMessage =
    error?.meta?.message ?? /message:\s*"([^"]*)"/.exec(message)?.[1] ?? message.split('\n').filter(Boolean).at(-1) ?? ''
  const hint = /hint:\s*Some\("([^"]*)"\)/.exec(message)?.[1] ?? ''
  return { code, pgMessage, hint }
}

async function expectFailure(id, sql, run) {
  try {
    await run()
    record(id, sql, '未报错（预期应被拦）', false)
  } catch (error) {
    const { code, pgMessage, hint } = extractPgError(error)
    // 只认数据库约束错误（23514 check_violation）；其它异常不算「被拦」
    const pass = code === '23514' && /cannot be .* without at least one source span citation/.test(pgMessage)
    record(id, sql, `SQLSTATE=${code} ${pgMessage}${hint ? ` | HINT: ${hint}` : ''}`, pass)
  }
}

// ── 准备：一个画布 / 节点 / 来源 / span ─────────────────────────────────────
// 先清掉上一次跑剩下的同名画布（Canvas 的级联会带走 Node/Source/Span/Concept/Problem）
const stale = await prisma.canvas.findMany({ where: { title: { startsWith: '017 写库实验' } }, select: { id: true } })
if (stale.length > 0) {
  await prisma.canvas.deleteMany({ where: { id: { in: stale.map((c) => c.id) } } })
  console.log(`清理旧测试画布 ${stale.length} 个`)
}

// 空库路径下没有任何用户，按需建一个（只为满足 Canvas.ownerId 外键）
const owner =
  (await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } })) ??
  (await prisma.user.create({
    data: { email: 'write-experiment@local.invalid', displayName: '写库实验' },
  }))
const canvas = await prisma.canvas.create({ data: { ownerId: owner.id, title: '017 写库实验' } })
const node = await prisma.node.create({ data: { canvasId: canvas.id, type: 'SOURCE', params: {} } })
const source = await prisma.source.create({
  data: { nodeId: node.id, kind: 'PPTX', filename: 'exp.pptx', mimeType: 'application/vnd.ms-powerpoint', pageCount: 1 },
})
const TEXT = '高阶导数是二阶和二阶以上的导数的统称。'
const span = await prisma.span.create({
  data: { sourceId: source.id, page: 1, region: 'SLIDE', charStart: 0, charEnd: TEXT.length, text: TEXT },
})

// ── a. Concept 无引用置 PENDING_REVIEW → 必须被拦 ─────────────────────────
const conceptA = await prisma.concept.create({
  data: { canvasId: canvas.id, name: 'a-无引用待审', definition: 'x', status: 'UNVERIFIED' },
})
await expectFailure(
  'a. Concept 无引用 → PENDING_REVIEW',
  `UPDATE "Concept" SET status='PENDING_REVIEW' WHERE id='${conceptA.id}'`,
  () => prisma.concept.update({ where: { id: conceptA.id }, data: { status: 'PENDING_REVIEW' } }),
)

// ── b. Concept 无引用置 VERIFIED → 必须被拦 ───────────────────────────────
const conceptB = await prisma.concept.create({
  data: { canvasId: canvas.id, name: 'b-无引用已验证', definition: 'x', status: 'UNVERIFIED' },
})
await expectFailure(
  'b. Concept 无引用 → VERIFIED',
  `UPDATE "Concept" SET status='VERIFIED' WHERE id='${conceptB.id}'`,
  () => prisma.concept.update({ where: { id: conceptB.id }, data: { status: 'VERIFIED' } }),
)

// ── c. Problem 无引用置 VERIFIED → 必须被拦 ───────────────────────────────
const problemC = await prisma.problem.create({
  data: {
    canvasId: canvas.id, type: 'SINGLE_CHOICE', stemMd: 's',
    options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }],
    answer: { key: 'A' }, judgeRule: 'CHOICE', status: 'PENDING',
  },
})
await expectFailure(
  'c. Problem 无引用 → VERIFIED',
  `UPDATE "Problem" SET status='VERIFIED' WHERE id='${problemC.id}'`,
  () => prisma.problem.update({ where: { id: problemC.id }, data: { status: 'VERIFIED' } }),
)

// ── d. Problem 置 PENDING / REJECTED（带 rejectReason）→ 必须成功 ─────────
{
  const sql = `UPDATE "Problem" SET status='PENDING' WHERE id='${problemC.id}'; ` +
    `UPDATE "Problem" SET status='REJECTED', "rejectReason"='三检未过' WHERE id='${problemC.id}'`
  try {
    await prisma.problem.update({ where: { id: problemC.id }, data: { status: 'PENDING' } })
    const rejected = await prisma.problem.update({
      where: { id: problemC.id },
      data: { status: 'REJECTED', rejectReason: '三检未过' },
    })
    record('d. Problem → PENDING / REJECTED（带理由）', sql, `status=${rejected.status} rejectReason=${rejected.rejectReason}`, rejected.status === 'REJECTED')
  } catch (error) {
    record('d. Problem → PENDING / REJECTED（带理由）', sql, `意外报错：${error.message}`, false)
  }
}

// ── 降级 1：Concept 最后一条引用删掉 → PENDING_REVIEW 应变 UNVERIFIED ─────
{
  const concept = await prisma.concept.create({
    data: { canvasId: canvas.id, name: '降级-待审概念', definition: 'x', status: 'UNVERIFIED' },
  })
  const citation = await prisma.conceptCitation.create({
    data: { conceptId: concept.id, spanId: span.id, isPrimary: true, quote: TEXT },
  })
  await prisma.concept.update({ where: { id: concept.id }, data: { status: 'PENDING_REVIEW' } })
  const before = await prisma.concept.findUniqueOrThrow({ where: { id: concept.id } })
  await prisma.conceptCitation.delete({ where: { id: citation.id } })
  const after = await prisma.concept.findUniqueOrThrow({ where: { id: concept.id } })
  record(
    '降级 1. Concept 删光引用：PENDING_REVIEW → ?',
    `DELETE FROM "ConceptCitation" WHERE id='${citation.id}'`,
    `${before.status} → ${after.status}`,
    before.status === 'PENDING_REVIEW' && after.status === 'UNVERIFIED',
  )
}

// ── 降级 2：Problem 最后一条引用删掉 → VERIFIED 应变 PENDING（不是 UNVERIFIED）──
{
  const problem = await prisma.problem.create({
    data: {
      canvasId: canvas.id, type: 'SINGLE_CHOICE', stemMd: 's2',
      options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }],
      answer: { key: 'A' }, judgeRule: 'CHOICE', status: 'PENDING',
    },
  })
  const citation = await prisma.problemCitation.create({
    data: { problemId: problem.id, spanId: span.id },
  })
  await prisma.problem.update({ where: { id: problem.id }, data: { status: 'VERIFIED' } })
  const before = await prisma.problem.findUniqueOrThrow({ where: { id: problem.id } })
  await prisma.problemCitation.delete({ where: { id: citation.id } })
  const after = await prisma.problem.findUniqueOrThrow({ where: { id: problem.id } })
  record(
    '降级 2. Problem 删光引用：VERIFIED → ?（必须是 PENDING）',
    `DELETE FROM "ProblemCitation" WHERE id='${citation.id}'`,
    `${before.status} → ${after.status}`,
    before.status === 'VERIFIED' && after.status === 'PENDING',
  )
}

// ── 视图：v_verified_without_citation 必须 0 行 ───────────────────────────
{
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM "v_verified_without_citation" WHERE "entityId" IN (SELECT id FROM "Concept" WHERE "canvasId"='${canvas.id}')`,
  )
  record(
    '视图 v_verified_without_citation（本画布）必须 0 行',
    `SELECT * FROM "v_verified_without_citation" WHERE 本画布`,
    `rows=${rows.length}`,
    rows.length === 0,
  )
}

const failed = results.filter((r) => !r.pass)
console.log('\n' + JSON.stringify({ database: databaseUrl.replace(/.*\//, ''), total: results.length, passed: results.length - failed.length, failed: failed.map((r) => r.id) }, null, 2))
await prisma.$disconnect()
process.exit(failed.length === 0 ? 0 : 1)
