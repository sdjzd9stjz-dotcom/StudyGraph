import assert from 'node:assert/strict'
import test from 'node:test'

import { deepenExecutor } from '../../src/nodes/executors/deepen.ts'
import { lectureExecutor } from '../../src/nodes/executors/lecture.ts'

/**
 * 深入理解 / 导出讲义。
 *
 * 这两个节点是"知识网络"的收口：前者把卡片与题目收敛成核心观点，
 * 后者把多个节点的产出与对话写成讲义。共同点是**不许编材料之外的东西**，
 * 所以模型返回空数组/空正文时必须失败，而不是写一张空卡片糊弄过去。
 */

const usage = { tokensIn: 100, tokensOut: 50, cachedTokens: 0 }

function makeCtx(inputs: Record<string, unknown>, response: unknown) {
  const calls: any[] = []
  return {
    calls,
    ctx: {
      params: {},
      inputs,
      skills: [],
      canvasId: 'canvas-1',
      nodeId: 'node-1',
      user: { id: 'u1', email: 'u@t.t', displayName: 'u' },
      prisma: {},
      objectStore: {},
      spans: { resolve: async () => null, pageText: async () => undefined, verify: async () => ({ ok: false }) },
      llm: {
        complete: async (request: any) => {
          calls.push(request)
          return { data: response, usage, modelVersion: 'deepseek-flash', provider: 'deepseek' }
        },
      },
    } as never,
  }
}

const context = [
  {
    nodeId: 'card-1',
    type: 'CARD',
    title: '上确界',
    artifactKind: 'CONCEPT_CARD',
    summary: '🗂 1 张知识卡',
    conversation: '用户：为什么 ε 要取任意正数？\n助手：因为它要求"任意小"，不是某一个固定的小量。',
    port: 'in',
  },
  {
    nodeId: 'quiz-1',
    type: 'QUIZ',
    title: '出题',
    artifactKind: 'PROBLEM_DRAFT',
    summary: '✏️ 出题 2 道',
    conversation: '',
    port: 'in',
  },
]

test('深入理解：把卡片与题目的对话收敛成核心观点，并带出处', async () => {
  const { ctx, calls } = makeCtx(
    { upstreamContext: context },
    {
      points: [
        { title: 'ε 的语言', insight: '确界的定义靠"任意小"来刻画最小的上界。', evidence: '上确界' },
        { title: '题目的作用', insight: '题目检验的是定义的使用，而不是计算。', evidence: '出题' },
      ],
      summary: '两个节点都在围绕确界的刻画方式。',
    },
  )

  const result = await deepenExecutor.run(ctx)

  assert.equal(result.outputs.points.length, 2)
  assert.equal(result.outputs.summary.includes('确界'), true)
  // 上游对话必须真的进了提示词：这正是"连线 = 对话总结作为上下文"的落点
  const userMessage = calls[0].messages.find((message: any) => message.role === 'user').content as string
  assert.match(userMessage, /为什么 ε 要取任意正数/)
  assert.match(userMessage, /出题 2 道/)
  assert.equal(calls[0].maxTokens, 4096)
})

test('深入理解：模型给不出观点 → 失败，不写空卡片', async () => {
  const { ctx } = makeCtx({ upstreamContext: context }, { points: [], summary: '' })
  await assert.rejects(() => deepenExecutor.run(ctx), /没有给出可用的核心观点/)
})

test('深入理解：没有任何材料 → 明确说是缺输入', async () => {
  const { ctx } = makeCtx({}, { points: [], summary: '' })
  await assert.rejects(() => deepenExecutor.run(ctx), /需要上游的知识卡或题目/)
})

test('导出讲义：多节点材料汇总成标题 / 大纲 / 正文', async () => {
  const { ctx, calls } = makeCtx(
    { upstreamContext: context },
    {
      title: '前三章与微分复习讲义',
      outline: ['概念与定义', '常见疑问'],
      markdown: '## 概念与定义\n\n上确界……\n\n## 常见疑问\n\n为什么 ε 要取任意正数？',
    },
  )

  const result = await lectureExecutor.run(ctx)

  assert.equal(result.outputs.title, '前三章与微分复习讲义')
  assert.deepEqual(result.outputs.outline, ['概念与定义', '常见疑问'])
  assert.match(String(result.outputs.markdown), /为什么 ε 要取任意正数/)
  assert.equal(calls[0].maxTokens, 8192)
})

test('导出讲义：没有上游节点 → 失败；模型返回空正文 → 失败', async () => {
  const empty = makeCtx({ upstreamContext: [] }, { title: 'x', outline: [], markdown: '' })
  await assert.rejects(() => lectureExecutor.run(empty.ctx), /需要至少一个上游节点/)

  const blank = makeCtx({ upstreamContext: context }, { title: 'x', outline: [], markdown: '   ' })
  await assert.rejects(() => lectureExecutor.run(blank.ctx), /没有返回讲义正文/)
})
