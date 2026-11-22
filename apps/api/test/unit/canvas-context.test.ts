import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCanvasContext } from '../../src/routes/assistant-agent.ts'

/**
 * 底部对话的上下文。
 *
 * 用户的原话：「以全部卡片及其内容为上下文，可以回答使用者关于一切问题的答案」。
 * 以前只把「标题 + 状态」交给模型，内容要靠它自己调工具去读 —— 读不读全看它心情。
 * 这里钉死：**内容必须默认在里面**，包括节点自己的对话；
 * 裁掉的部分必须明确标注，不能悄悄丢。
 */

function prismaWith(options: {
  nodes: Array<{ id: string; type: string; title: string | null; status: string }>
  artifacts?: Array<{ nodeId: string; kind: string; structured: unknown }>
  messages?: Array<{ nodeId: string; role: string; content: string }>
  edges?: Array<{ fromNodeId: string; toNodeId: string }>
}) {
  return {
    node: { findMany: async () => options.nodes },
    edge: { findMany: async () => options.edges ?? [] },
    artifact: { findMany: async () => options.artifacts ?? [] },
    nodeMessage: { findMany: async () => options.messages ?? [] },
  } as never
}

const depsOf = (options: Parameters<typeof prismaWith>[0]) => ({
  prisma: prismaWith(options),
  canvasId: 'canvas-1',
  userId: 'user-1',
}) as never

const cardArtifact = {
  nodeId: 'card-1',
  kind: 'CONCEPT_CARD',
  structured: {
    cards: {
      total: 1,
      verified: 0,
      pendingReview: 1,
      cards: [{ name: '上确界', definition: '它是上界，且任何更小的数都不是上界。' }],
    },
  },
}

test('上下文默认包含每个节点的产出内容，而不只是标题', async () => {
  const context = await buildCanvasContext(depsOf({
      nodes: [
        { id: 'card-1', type: 'CARD', title: '上确界', status: 'READY' },
        { id: 'quiz-1', type: 'QUIZ', title: '出题', status: 'DRAFT' },
      ],
      artifacts: [cardArtifact],
    }),
  )

  assert.match(context.text, /上确界/)
  assert.match(context.text, /它是上界，且任何更小的数都不是上界/)
  assert.match(context.text, /尚未运行，没有产物/, '没跑过的节点也要说明，别让模型以为它没内容')
  assert.equal(context.nodeCount, 2)
})

test('节点对话也进上下文（下游/助手能引用学生问过的问题）', async () => {
  const context = await buildCanvasContext(depsOf({
      nodes: [{ id: 'card-1', type: 'CARD', title: '上确界', status: 'READY' }],
      artifacts: [cardArtifact],
      messages: [
        { nodeId: 'card-1', role: 'user', content: '为什么 ε 要取任意正数？' },
        { nodeId: 'card-1', role: 'assistant', content: '因为它要求任意小。' },
      ],
    }),
  )

  assert.match(context.text, /为什么 ε 要取任意正数/)
  assert.match(context.text, /用户：/)
  assert.match(context.text, /助手：/)
})

test('连线也写进上下文，模型才知道谁是谁的下游', async () => {
  const context = await buildCanvasContext(depsOf({
      nodes: [
        { id: 'a', type: 'CHUNK', title: '切片', status: 'READY' },
        { id: 'b', type: 'EXTRACT', title: '概念抽取', status: 'READY' },
      ],
      edges: [{ fromNodeId: 'a', toNodeId: 'b' }],
    }),
  )
  assert.match(context.text, /切片 → 概念抽取/)
})

test('内容总量超出预算时按节点截断，并明确告诉模型可以读全文（不悄悄丢）', async () => {
  // 80 个节点 × 每张卡一段定义：总量必然超过 16000 字的上下文预算
  const nodes = Array.from({ length: 80 }, (_, index) => ({
    id: `card-${index}`,
    type: 'CARD',
    title: `概念${index}`,
    status: 'READY',
  }))
  // 每个节点一段可读文本（切片摘要约 450 字）：节点一多，单节点也会被压到 400 字以内
  const artifacts = nodes.map((node) => ({
    nodeId: node.id,
    kind: 'CHUNKS',
    structured: {
      chunkSet: {
        chunks: Array.from({ length: 5 }, (_, index) => ({
          id: `c${index}`,
          text: `第 ${index} 段：${'内容'.repeat(30)}`,
        })),
      },
    },
  }))

  const context = await buildCanvasContext(depsOf({ nodes, artifacts }))

  assert.ok(context.text.length <= 20_000, `上下文必须被预算约束，实际 ${context.text.length}`)
  assert.ok(context.truncated >= 1, '裁剪发生时必须计数')
  assert.match(context.text, /已截断|read_node_output/)
})

test('空画布明确说明，而不是给一段空字符串', async () => {
  const context = await buildCanvasContext(depsOf({ nodes: [] }))
  assert.equal(context.text, '（空画布）')
  assert.equal(context.nodeCount, 0)
})
