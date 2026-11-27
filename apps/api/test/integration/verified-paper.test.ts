import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { prisma } from '../../../../packages/db/src/index.ts'
import { buildApp } from '../../src/app.ts'
import { summarizeArtifact } from '../../src/domain/artifact-text.ts'
import { loadEnv } from '../../src/env.ts'
import { issueToken } from '../../src/lib/pat.ts'
import type { LLMGateway } from '../../src/llm/types.ts'
import { executeNode } from '../../src/nodes/execute.ts'
import { createObjectStore } from '../../src/storage/object-store.ts'

test('从题库质检到试卷写入，只放行本画布的 VERIFIED 题', async t => {
  const user = await prisma.user.create({ data: { email: randomUUID() + '@paper.invalid', displayName: '组卷测试' } })
  const canvas = await prisma.canvas.create({ data: { ownerId: user.id, title: '组卷测试' } })
  const canvasId = canvas.id
  const app = await buildApp({ env: loadEnv({ ...process.env, NODE_ENV: 'test' }), prisma })
  t.after(async () => {
    await app.close()
    await prisma.paper.deleteMany({ where: { canvasId } })
    await prisma.user.delete({ where: { id: user.id } })
  })
  const { token, tokenHash, tokenPrefix } = issueToken()
  await prisma.personalAccessToken.create({ data: { userId: user.id, name: 'test', tokenHash, tokenPrefix, scopes: ['CANVAS_WRITE'] } })
  const assemble = (ids: string[]) => app.inject({ method: 'POST', url: '/v1/papers/assemble',
    headers: { authorization: `Bearer ${token}` }, payload: { problemIds: ids, pointsPerProblem: 3 } })
  const quiz = await prisma.node.create({ data: { canvasId, type: 'QUIZ' } })
  const check = await prisma.node.create({ data: { canvasId, type: 'CHECK', params: { stem: ' ', answer: ' ' } } })
  const paper = await prisma.node.create({ data: { canvasId, type: 'PAPER', params: { durationMin: 20 } } })
  await prisma.edge.create({ data: { canvasId, kind: 'DERIVED_FROM', fromNodeId: quiz.id, toNodeId: check.id } })
  const source = await prisma.source.create({ data: { nodeId: quiz.id, kind: 'PDF', filename: 'questions.pdf', mimeType: 'application/pdf' } })
  const span = await prisma.span.create({ data: { sourceId: source.id, page: 1, region: 'SLIDE', text: '题源', charStart: 0, charEnd: 2 } })
  const makeProblem = (stemMd: string) => prisma.problem.create({ data: { canvasId, sourceNodeId: quiz.id,
    type: 'NUMERIC', judgeRule: 'EXACT', stemMd, answer: '4', citations: { create: { spanId: span.id } } } })
  const first = await makeProblem('2+2'), second = await makeProblem('1+3'), wrong = await makeProblem('2+3')
  const incomplete = await makeProblem('缺少一项检查'), otherBatch = await makeProblem('2+2')
  const ids = [first.id, second.id, wrong.id, incomplete.id]
  await prisma.artifact.create({ data: { nodeId: quiz.id, kind: 'PROBLEM_DRAFT', hash: randomUUID(), structured: { created: ids.map(id => ({ id })) } } })
  let calls = 0
  const pass = { pass: true, reason: '符合' }
  const llm: LLMGateway = {
    routeFor() { throw Error('未预期的模型路由') },
    chatWithTools() { throw Error('未预期的工具调用') },
    async complete(req) {
      calls++
      const text = req.messages.find(message => message.role === 'user')!.content
      return { provider: 'openai', modelVersion: 'test-v1', usage: { tokensIn: 5, tokensOut: 2, cachedTokens: 0 },
        data: { solvable: pass, answerCorrect: text.includes('2+3') ? { pass: false, reason: '答案应为 5' } : pass,
          ...(text.includes('缺少一项') ? {} : { distractorsValid: pass }) } }
    },
  }
  const run = (id: string) => executeNode({ user, prisma, llm, objectStore: createObjectStore({}) }, id, { dryRun: false })
  const latestPaper = () => prisma.paper.findFirstOrThrow({ where: { canvasId }, orderBy: { createdAt: 'desc' }, include: { items: { orderBy: { order: 'asc' } } } })

  await t.test('全待检时手工组卷零写入，自动组卷生成带缺口的空草稿', async () => {
    const response = await assemble([first.id])
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error.code, 'PROBLEM_NOT_VERIFIED')
    assert.equal(await prisma.paper.count({ where: { canvasId } }), 0)
    await run(paper.id)
    const draft = await latestPaper()
    assert.equal(draft.items.length, 0)
    assert.match(summarizeArtifact('PAPER_SPEC', { report: draft.report }), /需要 4 道，实取 0 道/)
    assert.equal((await run(paper.id)).cacheHit, true)
  })

  await t.test('手填单题只预览，直连出题后才逐题写回，缺项与明确失败均驳回', async () => {
    await prisma.node.update({ where: { id: check.id }, data: { params: { stem: '2+2', answer: '4' } } })
    await run(check.id)
    assert.equal(await prisma.problem.count({ where: { canvasId, status: 'PENDING' } }), 5)
    await prisma.node.update({ where: { id: check.id }, data: { params: { stem: ' ', answer: ' ' } } })
    const checked = await run(check.id)
    assert.equal(checked.tokensIn, 20)
    assert.equal(await prisma.problem.count({ where: { canvasId, status: 'VERIFIED' } }), 2)
    const status = (id: string) => prisma.problem.findUniqueOrThrow({ where: { id } })
    assert.equal((await status(wrong.id)).rejectReason, '答案应为 5')
    assert.equal((await status(incomplete.id)).rejectReason, '质检未返回该项结果')
    assert.equal((await status(otherBatch.id)).status, 'PENDING')
    const verdict = await prisma.artifact.findFirstOrThrow({ where: { runId: checked.runId! } })
    assert.match(summarizeArtifact('CHECK_VERDICT', verdict.structured), /通过 2 道，驳回 2 道/)
    assert.equal((await run(check.id)).tokensIn, 0)
    assert.equal(calls, 5)
  })

  await t.test('合格题变化后重新自动组卷，实取数与试卷明细一致', async () => {
    assert.equal((await run(paper.id)).cacheHit, false)
    const draft = await latestPaper()
    assert.deepEqual(draft.items.map(item => item.problemId).sort(), [first.id, second.id].sort())
    assert.match(summarizeArtifact('PAPER_SPEC', { report: draft.report }), /组卷：2 道[\s\S]*需要 4 道，实取 2 道/)
    assert.equal((await run(paper.id)).cacheHit, true)
  })

  await t.test('手工混选、跨画布全部拒绝，合格题按勾选顺序计分', async () => {
    const count = await prisma.paper.count({ where: { canvasId } })
    const other = await prisma.canvas.create({ data: { ownerId: user.id, title: '另一张画布' } })
    const foreign = await prisma.problem.create({ data: { canvasId: other.id, type: 'NUMERIC', judgeRule: 'EXACT', stemMd: '1+1', answer: '2' } })
    for (const [id, code] of [[wrong.id, 'PROBLEM_REJECTED'], [otherBatch.id, 'PROBLEM_NOT_VERIFIED'], [foreign.id, 'PROBLEM_CROSS_CANVAS']] as const) {
      const response = await assemble([first.id, id])
      assert.equal(response.statusCode, 400)
      assert.equal(response.json().error.code, code)
    }
    assert.equal(await prisma.paper.count({ where: { canvasId } }), count)
    const response = await assemble([second.id, first.id, second.id])
    assert.equal(response.statusCode, 201)
    assert.equal(response.json().totalPoints, 6)
    assert.deepEqual((await latestPaper()).items.map(item => [item.problemId, item.points]), [[second.id, 3], [first.id, 3]])
  })

  await t.test('提交时正遇到题目降级，等待行锁后拒绝整卷；历史卷保留', async () => {
    const previous = await latestPaper()
    const count = await prisma.paper.count({ where: { canvasId } })
    let request!: Promise<Awaited<ReturnType<typeof assemble>>>
    await prisma.$transaction(async tx => {
      await tx.problemCitation.deleteMany({ where: { problemId: first.id } })
      request = assemble([first.id, second.id]).then(response => response)
      // 等到组卷确实被这次降级挡在锁上，再提交降级，避免靠固定延时碰运气。
      for (let i = 0; i < 120; i++) {
        await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`
        const [state] = await tx.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%FOR SHARE%'
        ) AS waiting`
        if (state?.waiting) return
        await delay(20)
      }
      assert.fail('组卷未等待正在降级的题目')
    })
    assert.equal((await request).json().error.code, 'PROBLEM_NOT_VERIFIED')
    assert.equal(await prisma.paper.count({ where: { canvasId } }), count)
    assert.equal(await prisma.paperItem.count({ where: { paperId: previous.id } }), 2)
    assert.equal((await run(paper.id)).cacheHit, false)
    assert.deepEqual((await latestPaper()).items.map(item => item.problemId), [second.id])
    await assert.rejects(() => run(check.id), /缺少原文引用/)
    assert.equal(calls, 5)
  })
})
