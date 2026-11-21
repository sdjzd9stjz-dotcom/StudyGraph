import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { prisma } from '../../../../packages/db/src/index.ts'
import { quizExecutor } from '../../src/nodes/executors/quiz.ts'
import { gradeExecutor } from '../../src/nodes/executors/grade.ts'
import type { NodeExecutorRunCtx } from '../../src/nodes/contract.ts'
import type { LLMGateway } from '../../src/llm/types.ts'

/**
 * QUIZ / GRADE 的落库验收（真 PG）。
 *
 * 这两条是这个项目最容易被"跑通了"骗过去的地方：
 *   · quiz 只要返回一个 JSON 就看起来成功了，但题库、组卷、作答、错因看板
 *     全靠 `Problem` 表 —— 不写库，四条链一起空着，界面上完全看不出原因
 *   · grade 不写 `Attempt`，答题记录永远是空的，熟练度和错因统计全是 0

 * 所以这里测的是**库里真的多了什么**，不是返回值对不对。
 *
 * 用桩 LLM：测的是落库与清洗逻辑，不是模型质量。
 */

/** 固定返回给定 JSON 的桩网关，顺带记录被调用了几次 */
function stubGateway(payload: unknown): LLMGateway & { calls: number } {
  const gateway = {
    calls: 0,
    routeFor: () => null,
    async complete() {
      gateway.calls += 1
      return {
        data: payload,
        usage: { tokensIn: 100, tokensOut: 50, cachedTokens: 0 },
        provider: 'stub',
        modelVersion: 'stub-v1',
      }
    },
  }
  return gateway as unknown as LLMGateway & { calls: number }
}

/**
 * 执行器只读 `user.id`（用来落 Attempt.userId 与 MethodApplication.userId）。
 *
 * 不要写成 `as never`：那样 `user.id = owner.id` 之后，任何读 user 的地方
 * 类型都会塌成 never，报错却指向别的高亮错误行。
 */
const user = { id: '', email: 'stub@quiz.invalid', displayName: 'quiz-tester' }

async function makeCanvas(): Promise<{ owner: { id: string }; canvas: { id: string } }> {
  const owner = await prisma.user.create({
    data: { email: `${randomUUID()}@quiz.invalid`, displayName: 'quiz-tester' },
    select: { id: true },
  })
  const canvas = await prisma.canvas.create({
    data: { ownerId: owner.id, title: '出题落库验收' },
    select: { id: true },
  })
  return { owner, canvas }
}

/** 建一条带主引用的 VERIFIED 概念（citation 触发器要求先有引用才能 VERIFIED） */
async function makeConcept(
  canvasId: string,
  name: string,
  definition: string,
  quote: string,
): Promise<{ concept: { id: string }; span: { id: string }; node: { id: string } }> {
  const node = await prisma.node.create({
    data: { canvasId, type: 'EXTRACT', params: {}, posX: 0, posY: 0 },
  })
  const source = await prisma.source.create({
    data: { nodeId: node.id, kind: 'PPTX', filename: `${randomUUID()}.pptx`, mimeType: 'text/plain' },
  })
  // 每段引文用独立的 span：ProblemCitation 对 (problemId, spanId) 唯一
  const span = await prisma.span.create({
    data: { sourceId: source.id, page: 1, region: 'SLIDE', text: quote, charStart: 0, charEnd: quote.length },
  })
  /**
   * 概念先落成 UNVERIFIED（不带引用），再补引用，最后升状态。
   *
   * 不能一步 create 带 citations：`concept_verified_needs_citation` 触发器是
   * BEFORE INSERT OR UPDATE，只要行里 status 是 PENDING_REVIEW / VERIFIED 就查引用，
   * 而嵌套 create 时概念行先于引用行插入 —— 那一刻引用还没写，触发器直接拒绝。
   */
  const concept = await prisma.concept.create({
    data: { canvasId, name, definition, status: 'UNVERIFIED' },
  })
  await prisma.conceptCitation.create({
    data: { conceptId: concept.id, spanId: span.id, quote, isPrimary: true },
  })
  const verified = await prisma.concept.update({ where: { id: concept.id }, data: { status: 'VERIFIED' } })
  return { concept: verified, span, node }
}

function quizCtx(canvasId: string, nodeId: string, llm: LLMGateway, params: Record<string, unknown> = {}): NodeExecutorRunCtx<never> {
  return {
    params: params as never,
    inputs: {},
    llm,
    spans: { resolve: async () => null, pageText: async () => undefined, verify: async () => ({ ok: false, reason: null, detail: '' }) } as never,
    user,
    prisma: prisma as never,
    canvasId,
    nodeId,
    objectStore: {} as never,
    skills: [],
  }
}

test('QUIZ：题目真的写进了 Problem 表，且带引用、状态为 PENDING', async () => {
  const { owner, canvas } = await makeCanvas()
  const { concept, node } = await makeConcept(canvas.id, '导数的定义', '导数刻画函数在某点的瞬时变化率。', '导数刻画函数在某点的瞬时变化率。')
  user.id = owner.id

  const payload = {
    problems: [
      {
        type: 'SINGLE_CHOICE',
        stem: '函数 f(x)=x² 在 x=1 处的导数是？',
        options: [
          { key: 'A', text: '2' },
          { key: 'B', text: '1', errorTag: 'COMPUTE_SLIP', why: '把 x=1 直接代入原函数' },
          { key: 'C', text: '2x', errorTag: 'CONCEPT_GAP', why: '混淆导数值与导函数' },
        ],
        answer: 'A',
        judgeRule: 'CHOICE',
        difficulty: 2,
        bloom: 'APPLY',
        conceptNames: ['导数的定义'],
      },
    ],
  }
  const llm = stubGateway(payload)

  const before = await prisma.problem.count({ where: { canvasId: canvas.id } })
  await quizExecutor.run(quizCtx(canvas.id, node.id, llm))
  const after = await prisma.problem.count({ where: { canvasId: canvas.id } })

  assert.equal(before, 0)
  assert.equal(after, 1, '问题不在返回值，而在这里必须真的多了一道题')

  const problem = await prisma.problem.findFirstOrThrow({
    where: { canvasId: canvas.id },
    select: {
      id: true,
      status: true,
      type: true,
      judgeRule: true,
      answer: true,
      difficulty: true,
      sourceNodeId: true,
      options: true,
      concepts: { select: { conceptId: true } },
      citations: { select: { spanId: true } },
    },
  })

  // 只写 PENDING：三检（check 节点）没过之前不能升 VERIFIED
  assert.equal(problem.status, 'PENDING')
  assert.equal(problem.type, 'SINGLE_CHOICE')
  assert.equal(problem.judgeRule, 'CHOICE')
  assert.equal(problem.sourceNodeId, node.id, '题目要能回溯到出它的节点')
  assert.equal(problem.concepts.length, 1)
  assert.equal(problem.concepts[0]!.conceptId, concept.id)
  // 引用必须挂上，否则以后过三检也升不到 VERIFIED
  assert.equal(problem.citations.length, 1)

  const options = problem.options as Array<{ key: string; errorTag: string | null }>
  assert.equal(options.length, 3)
  // 正确项没有错因，两个错误项各自绑定
  assert.equal(options.find((option) => option.key === 'A')!.errorTag, null)
  assert.equal(options.find((option) => option.key === 'B')!.errorTag, 'COMPUTE_SLIP')
  assert.equal(options.find((option) => option.key === 'C')!.errorTag, 'CONCEPT_GAP')
})

test('QUIZ：错误项没有合法错因时被丢弃，不足 2 项则整题丢弃并说明原因', async () => {
  const { owner, canvas } = await makeCanvas()
  const { node } = await makeConcept(canvas.id, '单调性', '函数在区间上单调递增指自变量增大函数值增大。', '单调递增指自变量增大函数值增大。')
  user.id = owner.id

  const payload = {
    problems: [
      {
        type: 'SINGLE_CHOICE',
        stem: '这道题的错误项全都没有合法错因，应该被整题丢弃。',
        options: [
          { key: 'A', text: '对的' },
          { key: 'B', text: '错的', errorTag: '乱写一个', why: '没有合法错因' },
        ],
        answer: 'A',
        judgeRule: 'CHOICE',
        conceptNames: ['单调性'],
      },
      {
        type: 'SHORT_ANSWER',
        stem: '请简述导数的几何意义。',
        answer: '曲线在该点处切线的斜率。',
        judgeRule: 'EXACT',
        conceptNames: ['单调性'],
      },
      {
        type: 'FILL_BLANK',
        stem: '这题的考点名是模型编的，不该入库。',
        answer: 'x',
        judgeRule: 'EXACT',
        conceptNames: ['不存在的概念'],
      },
    ],
  }

  const result = await quizExecutor.run(quizCtx(canvas.id, node.id, stubGateway(payload)))
  const outputs = result.outputs as { actual: number; requested: number; dropped: Array<{ reason: string }> }

  assert.equal(outputs.actual, 1, '只有第二题该活下来')
  assert.equal(outputs.dropped.length, 2)
  assert.ok(outputs.dropped.some((entry) => entry.reason.includes('可用选项只有')))
  assert.ok(outputs.dropped.some((entry) => entry.reason.includes('没有引用任何给定的概念')))

  const stored = await prisma.problem.findMany({ where: { canvasId: canvas.id }, select: { stemMd: true } })
  assert.equal(stored.length, 1)
  assert.ok(stored[0]!.stemMd.includes('导数的几何意义'))
})

test('QUIZ：没有已确认概念时明确报错，不写空题', async () => {
  const { canvas } = await makeCanvas()
  const node = await prisma.node.create({ data: { canvasId: canvas.id, type: 'QUIZ', params: {}, posX: 0, posY: 0 } })

  await assert.rejects(
    () => quizExecutor.run(quizCtx(canvas.id, node.id, stubGateway({ problems: [] }))),
    /没有通过复核的概念/,
  )
  assert.equal(await prisma.problem.count({ where: { canvasId: canvas.id } }), 0)
})

test('GRADE：确定性判分的作答真的写进 Attempt，且错因来自选项配置', async () => {
  const { owner, canvas } = await makeCanvas()
  user.id = owner.id
  const node = await prisma.node.create({ data: { canvasId: canvas.id, type: 'GRADE', params: {}, posX: 0, posY: 0 } })

  const problem = await prisma.problem.create({
    data: {
      canvasId: canvas.id,
      type: 'SINGLE_CHOICE',
      stemMd: '1+1=?',
      answer: 'A',
      judgeRule: 'CHOICE',
      options: [
        { key: 'A', text: '2', errorTag: null, why: null },
        { key: 'B', text: '3', errorTag: 'COMPUTE_SLIP', why: '进位错误' },
      ] as never,
      status: 'PENDING',
    },
    select: { id: true },
  })

  const llm = stubGateway({})
  const result = await gradeExecutor.run({
    ...quizCtx(canvas.id, node.id, llm),
    params: {
      items: [
        { problemId: problem.id, answer: 'A' },
        { problemId: problem.id, answer: 'B' },
      ],
    } as never,
  })

  // 确定性判分不调模型：调了就是浪费 token 且引入不确定性
  assert.equal(llm.calls, 0)

  const outputs = result.outputs as { correct: number; wrong: number; pendingRubric: number }
  assert.equal(outputs.correct, 1)
  assert.equal(outputs.wrong, 1)
  assert.equal(outputs.pendingRubric, 0)

  const attempts = await prisma.attempt.findMany({
    where: { problemId: problem.id },
    orderBy: { createdAt: 'asc' },
    select: { isCorrect: true, errorTags: true },
  })
  assert.equal(attempts.length, 2, '两次作答必须各自留痕，否则无法复盘')
  assert.equal(attempts[0]!.isCorrect, true)
  assert.equal(attempts[1]!.isCorrect, false)
  // 错因来自选项自带的 errorTag —— 这是本项目与普通题库的区别
  assert.deepEqual(attempts[1]!.errorTags, [{ code: 'COMPUTE_SLIP' }])
})

test('GRADE：RUBRIC 且缺评分步骤时跳过并说明，不凭空判分', async () => {
  const { owner, canvas } = await makeCanvas()
  user.id = owner.id
  const node = await prisma.node.create({ data: { canvasId: canvas.id, type: 'GRADE', params: {}, posX: 0, posY: 0 } })
  const problem = await prisma.problem.create({
    data: {
      canvasId: canvas.id,
      type: 'SHORT_ANSWER',
      stemMd: '证明勾股定理。',
      answer: '略',
      judgeRule: 'RUBRIC',
      judgeSpec: {} as never,
      status: 'PENDING',
    },
    select: { id: true },
  })

  const llm = stubGateway({})
  const result = await gradeExecutor.run({
    ...quizCtx(canvas.id, node.id, llm),
    params: { items: [{ problemId: problem.id, answer: '用面积法' }] } as never,
  })

  const outputs = result.outputs as { skipped: Array<{ reason: string }>; pendingRubric: number }
  assert.equal(outputs.skipped.length, 1)
  assert.ok(outputs.skipped[0]!.reason.includes('judgeSpec.steps'))
  assert.equal(llm.calls, 0, '没有评分步骤就不该去问模型')
  assert.equal(await prisma.attempt.count({ where: { problemId: problem.id } }), 0)
})

test('GRADE：不属于本画布的题被跳过，不跨画布批改', async () => {
  const { owner, canvas } = await makeCanvas()
  const other = await makeCanvas()
  user.id = owner.id
  const node = await prisma.node.create({ data: { canvasId: canvas.id, type: 'GRADE', params: {}, posX: 0, posY: 0 } })
  const foreign = await prisma.problem.create({
    data: { canvasId: other.canvas.id, type: 'NUMERIC', stemMd: '2+2=?', answer: '4', judgeRule: 'EXACT', status: 'PENDING' },
    select: { id: true },
  })

  const result = await gradeExecutor.run({
    ...quizCtx(canvas.id, node.id, stubGateway({})),
    params: { items: [{ problemId: foreign.id, answer: '4' }] } as never,
  })
  const outputs = result.outputs as { graded: unknown[]; skipped: Array<{ reason: string }> }
  assert.equal(outputs.graded.length, 0)
  assert.ok(outputs.skipped[0]!.reason.includes('不属于这张画布'))
  assert.equal(await prisma.attempt.count({ where: { problemId: foreign.id } }), 0)
})
