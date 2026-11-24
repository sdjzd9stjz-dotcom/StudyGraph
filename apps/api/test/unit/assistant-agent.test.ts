import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CANVAS_TOOLS,
  executeCanvasTool,
  runCanvasAgent,
} from '../../src/routes/assistant-agent.ts'
import type { AgentDeps } from '../../src/routes/assistant-agent.ts'

/**
 * 画布 agent。
 *
 * 这里测的不是"模型聪不聪明"，而是**模型的每一句话能不能安全落地**：
 * 模型会编类型、编 id、把节点连到自己、试着改别的画布上的东西。
 * 这些如果不在工具层挡住，界面上看到的就是"AI 把图改坏了"，而不是一条报错。
 */

const CANVAS = 'canvas-1'
const USER = 'user-1'

interface FakeNode {
  id: string
  canvasId: string
  type: string
  title: string | null
  status: string
  params: Record<string, unknown>
  posX: number
  posY: number
  createdAt: number
}

function makePrisma(seed?: { nodes?: Partial<FakeNode>[]; artifacts?: Array<{ nodeId: string; kind: string; structured: unknown }> }) {
  const nodes: FakeNode[] = (seed?.nodes ?? []).map((node, index) => ({
    id: node.id ?? `n${index + 1}`,
    canvasId: node.canvasId ?? CANVAS,
    type: node.type ?? 'CARD',
    title: node.title ?? null,
    status: node.status ?? 'DRAFT',
    params: node.params ?? {},
    posX: node.posX ?? 0,
    posY: node.posY ?? 0,
    createdAt: node.createdAt ?? index,
  }))
  const edges: Array<{ id: string; canvasId: string; fromNodeId: string; toNodeId: string; kind: string }> = []
  const artifacts = (seed?.artifacts ?? []).map((artifact) => ({ ...artifact }))
  const usage: unknown[] = []
  let counter = 0

  const pick = <T extends object>(row: T, select?: Record<string, boolean>) => {
    if (!select) return row
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(select)) if (select[key]) out[key] = (row as Record<string, unknown>)[key]
    return out
  }

  const prisma = {
    node: {
      findMany: async ({ where, orderBy, select }: any) => {
        let rows = nodes.filter((node) => (where?.canvasId ? node.canvasId === where.canvasId : true))
        if (where?.id?.in) rows = rows.filter((node) => where.id.in.includes(node.id))
        if (orderBy?.createdAt === 'asc') rows = [...rows].sort((a, b) => a.createdAt - b.createdAt)
        return rows.map((row) => pick(row, select))
      },
      findFirst: async ({ where, orderBy, select }: any) => {
        let rows = nodes.filter((node) => node.id === where.id && node.canvasId === where.canvasId)
        if (where?.canvasId && !where?.id) rows = nodes.filter((node) => node.canvasId === where.canvasId)
        if (orderBy?.posX === 'desc') rows = [...rows].sort((a, b) => b.posX - a.posX)
        const row = rows[0]
        return row ? pick(row, select) : null
      },
      create: async ({ data, select }: any) => {
        counter += 1
        const row: FakeNode = {
          id: `new-${counter}`,
          canvasId: data.canvasId,
          type: data.type,
          title: data.title ?? null,
          status: data.status ?? 'DRAFT',
          params: data.params ?? {},
          posX: data.posX ?? 0,
          posY: data.posY ?? 0,
          createdAt: 1000 + counter,
        }
        nodes.push(row)
        return pick(row, select)
      },
      update: async ({ where, data, select }: any) => {
        const row = nodes.find((node) => node.id === where.id)!
        Object.assign(row, data)
        return pick(row, select)
      },
      delete: async ({ where }: any) => {
        const index = nodes.findIndex((node) => node.id === where.id)
        const [row] = nodes.splice(index, 1)
        return row
      },
    },
    edge: {
      findMany: async ({ where, select }: any) => edges.filter((edge) => edge.canvasId === where.canvasId).map((edge) => pick(edge, select)),
      findFirst: async ({ where, select }: any) => {
        const row = edges.find(
          (edge) =>
            edge.canvasId === where.canvasId &&
            (!where.id || edge.id === where.id) &&
            (!where.fromNodeId || edge.fromNodeId === where.fromNodeId) &&
            (!where.toNodeId || edge.toNodeId === where.toNodeId),
        )
        return row ? pick(row, select) : null
      },
      create: async ({ data, select }: any) => {
        counter += 1
        const row = { id: `e-${counter}`, kind: 'DERIVED_FROM', ...data }
        edges.push(row)
        return pick(row, select)
      },
      delete: async ({ where }: any) => {
        const index = edges.findIndex((edge) => edge.id === where.id)
        return edges.splice(index, 1)[0]
      },
      deleteMany: async ({ where }: any) => {
        const keep = edges.filter(
          (edge) =>
            !(
              edge.canvasId === where.canvasId &&
              where.OR.some((clause: any) => edge.fromNodeId === clause.fromNodeId || edge.toNodeId === clause.toNodeId)
            ),
        )
        const removed = edges.length - keep.length
        edges.length = 0
        edges.push(...keep)
        return { count: removed }
      },
    },
    artifact: {
      findFirst: async ({ where, select }: any) => {
        const row = artifacts.find((artifact) => artifact.nodeId === where.nodeId)
        return row ? pick(row, select) : null
      },
      findMany: async () => [],
    },
    nodeMessage: {
      findMany: async () => [],
    },
    usageRecord: {
      create: async ({ data }: any) => {
        usage.push(data)
        return data
      },
    },
  }

  return { prisma: prisma as never, state: { nodes, edges, usage } }
}

const depsOf = (prisma: unknown, canvasId = CANVAS): AgentDeps => ({ prisma: prisma as never, canvasId, userId: USER })

test('工具清单只包含画布操作，没有执行节点 / 文件 / 网络', () => {
  const names = CANVAS_TOOLS.map((tool) => tool.name)
  assert.deepEqual(names, [
    'list_canvas',
    'split_cards',
    'read_node_output',
    'arrange_nodes',
    'create_node',
    'update_node',
    'delete_node',
    'create_edge',
    'delete_edge',
  ])
  assert.equal(names.some((name) => /run|exec|shell|file|http|fetch|upload/i.test(name)), false)
})

test('create_node：模型编的节点类型被拒绝，合法类型落成 DRAFT', async () => {
  const { prisma, state } = makePrisma({ nodes: [{ id: 'n1', type: 'SOURCE', posX: 100 }] })
  const bad = await executeCanvasTool(depsOf(prisma), 'create_node', JSON.stringify({ type: 'KNOWLEDGE' }))
  assert.equal(bad.result.ok, false)
  assert.match(String(bad.result.error), /不支持的节点类型/)

  const good = await executeCanvasTool(depsOf(prisma), 'create_node', JSON.stringify({ type: 'QUIZ', title: '小测' }))
  assert.equal(good.result.ok, true)
  assert.equal(good.change?.kind, 'create-node')
  assert.equal(state.nodes.length, 2)
  // 新节点排在现有节点右侧，而不是叠在原点
  assert.equal(state.nodes[1]!.posX, 420)
  assert.equal(state.nodes[1]!.status, 'DRAFT')
})

/**
 * 真实报障：AI 用 create_node 建了三张知识卡节点，三张内容一模一样。
 *
 * 原因就是这个工具原本写死 `params: {}` —— 没有 conceptName，
 * CARD 执行器读不到概念名，就把上游所有概念都做成卡。
 * 现在：建 CARD 必须给概念名，且概念名要真的写进 params。
 */
test('create_node：建知识卡必须绑定概念，否则内容会和别的卡重复', async () => {
  const { prisma, state } = makePrisma()
  const deps = depsOf(prisma)

  const missing = await executeCanvasTool(deps, 'create_node', JSON.stringify({ type: 'CARD', title: '定积分' }))
  assert.equal(missing.result.ok, false, '没有 conceptName 的 CARD 必须被拒绝')
  assert.match(String(missing.result.error), /conceptName/)
  assert.equal(state.nodes.length, 0, '被拒绝时不能留下半成品节点')

  const good = await executeCanvasTool(
    deps,
    'create_node',
    JSON.stringify({ type: 'CARD', conceptName: '定积分', posX: 10, posY: 20 }),
  )
  assert.equal(good.result.ok, true)
  const created = state.nodes.at(-1)!
  assert.deepEqual(created.params, { conceptName: '定积分' }, '概念名必须落进 params，执行器才认得')
  assert.equal(created.title, '定积分', '没给标题时用概念名当标题')

  // 别的类型不需要概念名
  const quiz = await executeCanvasTool(deps, 'create_node', JSON.stringify({ type: 'QUIZ' }))
  assert.equal(quiz.result.ok, true)
})

test('create_edge：自连、跨画布、端口不匹配都拒绝；合法连线只建一次', async () => {
  const { prisma, state } = makePrisma({
    nodes: [
      { id: 'a', type: 'CHUNK', title: '切片' },
      { id: 'b', type: 'EXTRACT', title: '抽取' },
      { id: 'other', type: 'CARD', canvasId: 'canvas-2' },
    ],
  })
  const deps = depsOf(prisma)

  assert.equal((await executeCanvasTool(deps, 'create_edge', JSON.stringify({ fromNodeId: 'a', toNodeId: 'a' }))).result.ok, false)
  assert.equal((await executeCanvasTool(deps, 'create_edge', JSON.stringify({ fromNodeId: 'a', toNodeId: 'other' }))).result.ok, false)

  const ok = await executeCanvasTool(deps, 'create_edge', JSON.stringify({ fromNodeId: 'a', toNodeId: 'b' }))
  assert.equal(ok.result.ok, true)
  assert.equal(ok.change?.kind, 'create-edge')
  assert.equal(state.edges.length, 1)

  const again = await executeCanvasTool(deps, 'create_edge', JSON.stringify({ fromNodeId: 'a', toNodeId: 'b' }))
  assert.equal(again.result.ok, true)
  assert.equal(state.edges.length, 1, '重复连线不能建两条')
})

test('跨画布的节点 id：改、读、删一律拒绝（不能用对话动别人的画布）', async () => {
  const { prisma, state } = makePrisma({ nodes: [{ id: 'foreign', canvasId: 'canvas-2', title: '别人的' }] })
  const deps = depsOf(prisma)
  for (const [tool, args] of [
    ['update_node', { nodeId: 'foreign', title: '改名' }],
    ['delete_node', { nodeId: 'foreign' }],
    ['read_node_output', { nodeId: 'foreign' }],
  ] as const) {
    const outcome = await executeCanvasTool(deps, tool, JSON.stringify(args))
    assert.equal(outcome.result.ok, false, `${tool} 必须拒绝跨画布 id`)
  }
  assert.equal(state.nodes.length, 1, '别人的节点必须原样还在')
  assert.equal(state.nodes[0]!.title, '别人的')
})

test('update_node：提示词写进 params.prompt，原有参数不丢', async () => {
  const { prisma, state } = makePrisma({
    nodes: [{ id: 'n1', type: 'EXTRACT', params: { batchSize: 15 } }],
  })
  const outcome = await executeCanvasTool(
    depsOf(prisma),
    'update_node',
    JSON.stringify({ nodeId: 'n1', prompt: '只抽定义，不要抽公式' }),
  )
  assert.equal(outcome.result.ok, true)
  assert.deepEqual(state.nodes[0]!.params, { batchSize: 15, prompt: '只抽定义，不要抽公式' })
})

test('delete_node：连带删掉它的连线', async () => {
  const { prisma, state } = makePrisma({
    nodes: [
      { id: 'a', type: 'CHUNK' },
      { id: 'b', type: 'EXTRACT' },
    ],
  })
  await executeCanvasTool(depsOf(prisma), 'create_edge', JSON.stringify({ fromNodeId: 'a', toNodeId: 'b' }))
  const outcome = await executeCanvasTool(depsOf(prisma), 'delete_node', JSON.stringify({ nodeId: 'b' }))
  assert.equal(outcome.result.ok, true)
  assert.equal(outcome.result.removedEdges, 1)
  assert.equal(state.edges.length, 0)
  assert.equal(state.nodes.length, 1)
})

test('read_node_output：没跑过的节点明确说没有产出，不编内容', async () => {
  const { prisma } = makePrisma({ nodes: [{ id: 'n1', type: 'CARD', title: '知识卡' }] })
  const outcome = await executeCanvasTool(depsOf(prisma), 'read_node_output', JSON.stringify({ nodeId: 'n1' }))
  assert.equal(outcome.result.ok, true)
  assert.equal(outcome.result.content, null)
  assert.match(String(outcome.result.note), /还没有运行/)
})

test('未知工具名 → 明确拒绝，而不是静默忽略', async () => {
  const { prisma } = makePrisma()
  const outcome = await executeCanvasTool(depsOf(prisma), 'run_node', '{}')
  assert.equal(outcome.result.ok, false)
  assert.match(String(outcome.result.error), /没有名为 run_node 的工具/)
})

test('非法 JSON 参数 → 拒绝，不抛异常把整轮对话打断', async () => {
  const { prisma } = makePrisma()
  const outcome = await executeCanvasTool(depsOf(prisma), 'create_node', '{type: CARD')
  assert.equal(outcome.result.ok, false)
  assert.match(String(outcome.result.error), /不是合法的 JSON/)
})

test('agent 循环：模型调工具 → 结果回灌 → 给出最终答复', async () => {
  const { prisma, state } = makePrisma()
  const requests: any[] = []
  const responses = [
    {
      content: '',
      toolCalls: [
        {
          id: 'call_1',
          name: 'create_node',
          arguments: JSON.stringify({ type: 'CARD', conceptName: '定积分', title: '定积分' }),
        },
      ],
    },
    {
      content: '我建好了一个知识卡节点。',
      toolCalls: [],
    },
  ]
  const llm = {
    chatWithTools: async (request: any) => {
      requests.push(request)
      const next = responses.shift()!
      return {
        ...next,
        usage: { tokensIn: 10, tokensOut: 5, cachedTokens: 0 },
        modelVersion: 'deepseek-flash',
        provider: 'deepseek',
      }
    },
  }

  const result = await runCanvasAgent(llm as never, depsOf(prisma), { message: '建个知识卡', history: [] })

  assert.equal(result.reply, '我建好了一个知识卡节点。')
  assert.equal(result.changes.length, 1)
  assert.equal(result.changes[0]!.kind, 'create-node')
  assert.equal(result.rounds, 2)
  assert.equal(state.nodes.length, 1, '工具必须真的执行了，而不只是模型说执行了')

  // 第二轮必须把工具结果以 tool 消息回灌，且带上原来的 toolCallId
  const second = requests[1]!.messages as Array<{ role: string; toolCallId?: string; content: string }>
  const toolMessage = second.find((message) => message.role === 'tool')
  assert.equal(toolMessage?.toolCallId, 'call_1')
  assert.match(String(toolMessage?.content), /"ok":true/)

  // 每轮都要计费留痕，否则对话量上去了对不上账
  assert.equal(state.usage.length, 2)
})

test('工具一直报错时，模型看得到错误、不会无限重试（轮次有上限）', async () => {
  const { prisma } = makePrisma()
  let calls = 0
  const llm = {
    chatWithTools: async () => {
      calls += 1
      return {
        content: '',
        toolCalls: [{ id: `call_${calls}`, name: 'delete_node', arguments: JSON.stringify({ nodeId: 'ghost' }) }],
        usage: { tokensIn: 1, tokensOut: 1, cachedTokens: 0 },
        modelVersion: 'deepseek-flash',
        provider: 'deepseek',
      }
    },
  }

  const result = await runCanvasAgent(llm as never, depsOf(prisma), { message: '删掉它', history: [] })
  assert.equal(calls, 6, '最多 6 轮，不能无限烧钱')
  assert.equal(result.changes.length, 0)
  assert.match(result.reply, /上限|没有改动/)
})
