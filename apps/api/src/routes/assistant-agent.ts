import { NODE_TYPES, defaultPortName, isNodeType, validateConnection } from '../../../../packages/contracts/src/index.ts'
import type { NodeType } from '../../../../packages/contracts/src/index.ts'
import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { summarizeArtifact } from '../domain/artifact-text.ts'
import { splitCardsForConcepts } from '../domain/split-cards.ts'
import { computeLayout } from '../domain/layout.ts'
import type { AgentMessage, LLMGateway, ToolSpec } from '../llm/types.ts'

/**
 * 底部对话栏的 agent（用户 2026-11-21：「你现在就是给下面的 ai 提供一套工具，
 * 就像 agent 一样，但是只能操作画板知识」）。
 *
 * 之前是"模型返回一份计划 → 用户点应用"。问题有三个：
 *   1. 模型没被真正当成执行者，多轮修改要反复点按钮
 *   2. 规划失败会静默退回关键词匹配 —— 用户看到的"AI"其实是正则
 *   3. 模型说"我改了"其实什么都没改，界面和行为对不上
 *
 * 现在是真正的工具循环：模型决定调哪个工具，**服务端执行**，结果回灌给模型，
 * 直到它给出答复。工具只碰画布（节点、连线、节点产出），
 * 不能执行节点、不能读文件、不能联网 —— 这是硬边界，不是提示词约定：
 * 每个工具都是这里写死的函数，模型只能调用这七个。
 */

const MAX_TOOL_ROUNDS = 6
/** 回灌给模型的工具结果上限：画布再大也不能一次塞爆上下文 */
const TOOL_RESULT_LIMIT = 4000
/** 单次读取节点产出的字符上限 */
const OUTPUT_LIMIT = 6000

export const CANVAS_TOOLS: readonly ToolSpec[] = [
  {
    name: 'list_canvas',
    description: '查看当前画布的全部节点与连线（含节点 id、类型、标题、状态）。改动前后都可以调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'split_cards',
    description:
      '把一个概念抽取节点里的概念**按知识点拆成多个知识卡节点**（一个概念一个节点），并自动连好 EXTRACT → CARD。用户要"知识卡"时优先用它，而不是建一个塞满所有卡的单节点。',
    parameters: {
      type: 'object',
      properties: { extractNodeId: { type: 'string', description: '概念抽取节点的 id' } },
      required: ['extractNodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_node_output',
    description: '读取某个节点最近一次运行产出的内容（知识卡、概念、题目等）。回答关于内容的问题前必须先调用它。',
    parameters: {
      type: 'object',
      properties: { nodeId: { type: 'string', description: '节点 id，从 list_canvas 得到' } },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'arrange_nodes',
    description: '按依赖方向把画布节点重新排成左→右（上游在左、下游在右）。只改位置，不改结构。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_node',
    description: `在画布上创建一个节点。类型只能是：${NODE_TYPES.join(' / ')}。`,
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '节点类型，必须是允许的 17 种之一' },
        title: { type: 'string', description: '节点标题（可选，默认用类型名）' },
        posX: { type: 'number', description: '画布横坐标（可选，默认排在现有节点右侧）' },
        posY: { type: 'number', description: '画布纵坐标（可选，默认 0）' },
      },
      required: ['type'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_node',
    description: '修改节点的标题或提示词（prompt）。prompt 是该节点运行时追加给模型的指令。',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        title: { type: 'string', description: '新标题（可选）' },
        prompt: { type: 'string', description: '新的节点提示词（可选，会写进 params.prompt）' },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_node',
    description: '删除一个节点及其所有连线。**只有用户明确要求删除时才调用。**',
    parameters: {
      type: 'object',
      properties: { nodeId: { type: 'string' } },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_edge',
    description: '连接两个节点（上游 → 下游）。两端必须在当前画布上，且不能自连。',
    parameters: {
      type: 'object',
      properties: {
        fromNodeId: { type: 'string', description: '上游节点 id' },
        toNodeId: { type: 'string', description: '下游节点 id' },
      },
      required: ['fromNodeId', 'toNodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_edge',
    description: '删除一条连线。**只有用户明确要求删除时才调用。**',
    parameters: {
      type: 'object',
      properties: { edgeId: { type: 'string' } },
      required: ['edgeId'],
      additionalProperties: false,
    },
  },
]

export type CanvasChangeKind =
  | 'create-node'
  | 'update-node'
  | 'delete-node'
  | 'create-edge'
  | 'delete-edge'

export interface CanvasChange {
  readonly kind: CanvasChangeKind
  readonly id: string
  readonly label: string
}

export interface ToolOutcome {
  readonly result: Record<string, unknown>
  readonly change?: CanvasChange
}

export interface AgentDeps {
  readonly prisma: PrismaClient
  readonly canvasId: string
  readonly userId: string
}

const fail = (error: string): ToolOutcome => ({ result: { ok: false, error } })
const ok = (result: Record<string, unknown>, change?: CanvasChange): ToolOutcome => ({
  result: { ok: true, ...result },
  ...(change ? { change } : {}),
})

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

const stringArg = (args: Record<string, unknown>, key: string): string | null => {
  const value = args[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * 执行一次工具调用。
 *
 * 每个 id 参数都必须验证「属于当前画布」—— 只信模型给的 id 就等于
 * 允许它通过对话改到别的画布，哪怕数据库的复合外键挡住了跨画布连边，
 * 删除和改名仍然会生效。
 */
export async function executeCanvasTool(
  deps: AgentDeps,
  name: string,
  rawArgs: string,
): Promise<ToolOutcome> {
  const args = parseArgs(rawArgs)
  if (!args) return fail(`参数不是合法的 JSON 对象：${rawArgs.slice(0, 120)}`)

  switch (name) {
    case 'list_canvas': {
      const [nodes, edges] = await Promise.all([
        deps.prisma.node.findMany({
          where: { canvasId: deps.canvasId },
          orderBy: { createdAt: 'asc' },
          select: { id: true, type: true, title: true, status: true, posX: true, posY: true },
        }),
        deps.prisma.edge.findMany({
          where: { canvasId: deps.canvasId },
          orderBy: { createdAt: 'asc' },
          select: { id: true, fromNodeId: true, toNodeId: true },
        }),
      ])
      return ok({
        nodes: nodes.map((node) => ({
          id: node.id,
          type: node.type,
          title: node.title ?? node.type,
          status: node.status,
          pos: { x: node.posX, y: node.posY },
        })),
        edges: edges.map((edge) => ({ id: edge.id, from: edge.fromNodeId, to: edge.toNodeId })),
      })
    }

    case 'split_cards': {
      const extractNodeId = stringArg(args, 'extractNodeId')
      if (!extractNodeId) return fail('缺少 extractNodeId')
      const extract = await deps.prisma.node.findFirst({
        where: { id: extractNodeId, canvasId: deps.canvasId, type: 'EXTRACT' },
        select: { id: true },
      })
      if (!extract) return fail('这个节点不是当前画布上的概念抽取节点')

      const outcome = await splitCardsForConcepts(deps.prisma, {
        canvasId: deps.canvasId,
        extractNodeId,
      })
      return {
        result: {
          ok: true,
          created: outcome.created.length,
          skipped: outcome.skipped.length,
          concepts: outcome.created.map((node) => node.conceptName),
        },
        ...(outcome.created.length > 0
          ? {
              change: {
                kind: 'create-node' as const,
                id: `split-${extractNodeId}-${Date.now()}`,
                label: `按概念拆出 ${outcome.created.length} 张知识卡`,
              },
            }
          : {}),
      }
    }

    case 'read_node_output': {
      const nodeId = stringArg(args, 'nodeId')
      if (!nodeId) return fail('缺少 nodeId')
      const node = await deps.prisma.node.findFirst({
        where: { id: nodeId, canvasId: deps.canvasId },
        select: { id: true, type: true, title: true, status: true },
      })
      if (!node) return fail(`当前画布上没有 id 为 ${nodeId} 的节点`)

      const artifact = await deps.prisma.artifact.findFirst({
        where: { nodeId },
        orderBy: { createdAt: 'desc' },
        select: { kind: true, structured: true },
      })
      if (!artifact) {
        return ok({ nodeId, title: node.title ?? node.type, content: null, note: '这个节点还没有运行过，没有产出' })
      }
      const text = summarizeArtifact(artifact.kind, artifact.structured)
      return ok({
        nodeId,
        title: node.title ?? node.type,
        kind: artifact.kind,
        truncated: text.length > OUTPUT_LIMIT,
        content: text.slice(0, OUTPUT_LIMIT),
      })
    }

    case 'arrange_nodes': {
      const [nodes, edges] = await Promise.all([
        deps.prisma.node.findMany({
          where: { canvasId: deps.canvasId },
          select: { id: true, posX: true, posY: true },
        }),
        deps.prisma.edge.findMany({ where: { canvasId: deps.canvasId }, select: { fromNodeId: true, toNodeId: true } }),
      ])
      const positions = computeLayout(
        nodes.map((node) => ({ id: node.id, x: node.posX, y: node.posY })),
        edges.map((edge) => ({ from: edge.fromNodeId, to: edge.toNodeId })),
      )
      await deps.prisma.$transaction(
        [...positions.entries()].map(([nodeId, pos]) =>
          deps.prisma.node.update({ where: { id: nodeId }, data: { posX: pos.x, posY: pos.y } }),
        ),
      )
      return ok(
        { moved: positions.size },
        { kind: 'update-node', id: 'layout', label: `整理 ${positions.size} 个节点的位置` },
      )
    }

    case 'create_node': {
      const type = stringArg(args, 'type')
      if (!type || !isNodeType(type)) {
        return fail(`不支持的节点类型：${String(args.type)}。只能是 ${NODE_TYPES.join(' / ')}`)
      }
      const title = typeof args.title === 'string' ? args.title.trim().slice(0, 200) : null

      // 默认排在现有节点右侧，避免多个新节点叠在原点
      let posX = typeof args.posX === 'number' && Number.isFinite(args.posX) ? args.posX : null
      let posY = typeof args.posY === 'number' && Number.isFinite(args.posY) ? args.posY : 0
      if (posX === null) {
        const rightmost = await deps.prisma.node.findFirst({
          where: { canvasId: deps.canvasId },
          orderBy: { posX: 'desc' },
          select: { posX: true },
        })
        posX = (rightmost?.posX ?? 0) + 320
      }

      const node = await deps.prisma.node.create({
        data: {
          canvasId: deps.canvasId,
          type: type as NodeType,
          title: title && title.length > 0 ? title : null,
          params: {},
          status: 'DRAFT',
          posX,
          posY,
        },
        select: { id: true, type: true, title: true },
      })
      return ok(
        { nodeId: node.id, type: node.type, title: node.title ?? node.type, status: 'DRAFT' },
        { kind: 'create-node', id: node.id, label: node.title ?? node.type },
      )
    }

    case 'update_node': {
      const nodeId = stringArg(args, 'nodeId')
      if (!nodeId) return fail('缺少 nodeId')
      const node = await deps.prisma.node.findFirst({
        where: { id: nodeId, canvasId: deps.canvasId },
        select: { id: true, title: true, params: true },
      })
      if (!node) return fail(`当前画布上没有 id 为 ${nodeId} 的节点`)

      const data: Record<string, unknown> = {}
      if (typeof args.title === 'string') data.title = args.title.trim().slice(0, 200)
      if (typeof args.prompt === 'string') {
        const params = (node.params ?? {}) as Record<string, unknown>
        data.params = { ...params, prompt: args.prompt.slice(0, 4000) }
      }
      if (Object.keys(data).length === 0) return fail('没有要修改的字段（title 或 prompt）')

      const updated = await deps.prisma.node.update({
        where: { id: nodeId },
        data,
        select: { id: true, title: true },
      })
      return ok(
        { nodeId, title: updated.title ?? nodeId, updated: Object.keys(data) },
        { kind: 'update-node', id: nodeId, label: updated.title ?? nodeId },
      )
    }

    case 'delete_node': {
      const nodeId = stringArg(args, 'nodeId')
      if (!nodeId) return fail('缺少 nodeId')
      const node = await deps.prisma.node.findFirst({
        where: { id: nodeId, canvasId: deps.canvasId },
        select: { id: true, title: true, type: true },
      })
      if (!node) return fail(`当前画布上没有 id 为 ${nodeId} 的节点`)

      const edges = await deps.prisma.edge.deleteMany({
        where: { canvasId: deps.canvasId, OR: [{ fromNodeId: nodeId }, { toNodeId: nodeId }] },
      })
      await deps.prisma.node.delete({ where: { id: nodeId } })
      return ok(
        { nodeId, removedEdges: edges.count },
        { kind: 'delete-node', id: nodeId, label: node.title ?? node.type },
      )
    }

    case 'create_edge': {
      const fromNodeId = stringArg(args, 'fromNodeId')
      const toNodeId = stringArg(args, 'toNodeId')
      if (!fromNodeId || !toNodeId) return fail('需要 fromNodeId 与 toNodeId')
      if (fromNodeId === toNodeId) return fail('不能把一个节点连到它自己')

      const nodes = await deps.prisma.node.findMany({
        where: { canvasId: deps.canvasId, id: { in: [fromNodeId, toNodeId] } },
        select: { id: true, type: true, title: true },
      })
      const from = nodes.find((node) => node.id === fromNodeId)
      const to = nodes.find((node) => node.id === toNodeId)
      if (!from || !to) return fail('连线的某一端不在当前画布上')

      const fromPort = defaultPortName(from.type, 'output')
      const toPort = defaultPortName(to.type, 'input')
      const check = validateConnection({
        fromType: from.type,
        fromPort: fromPort ?? '',
        toType: to.type,
        toPort: toPort ?? '',
      })
      if (!check.ok) return fail(`这两个节点不能这样连：${check.code ?? '端口不匹配'}`)

      const existing = await deps.prisma.edge.findFirst({
        where: { canvasId: deps.canvasId, fromNodeId, toNodeId, kind: 'DERIVED_FROM' },
        select: { id: true },
      })
      if (existing) return ok({ edgeId: existing.id, note: '这条连线已经存在，没有重复创建' })

      const created = await deps.prisma.edge.create({
        data: {
          canvasId: deps.canvasId,
          fromNodeId,
          toNodeId,
          kind: 'DERIVED_FROM',
          ...(fromPort ? { fromPort } : {}),
          ...(toPort ? { toPort } : {}),
        },
        select: { id: true },
      })
      return ok(
        { edgeId: created.id, from: fromNodeId, to: toNodeId },
        {
          kind: 'create-edge',
          id: created.id,
          label: `${from.title ?? from.type} → ${to.title ?? to.type}`,
        },
      )
    }

    case 'delete_edge': {
      const edgeId = stringArg(args, 'edgeId')
      if (!edgeId) return fail('缺少 edgeId')
      const edge = await deps.prisma.edge.findFirst({
        where: { id: edgeId, canvasId: deps.canvasId },
        select: { id: true, fromNodeId: true, toNodeId: true },
      })
      if (!edge) return fail(`当前画布上没有 id 为 ${edgeId} 的连线`)
      await deps.prisma.edge.delete({ where: { id: edgeId } })
      return ok(
        { edgeId, from: edge.fromNodeId, to: edge.toNodeId },
        { kind: 'delete-edge', id: edgeId, label: `${edge.fromNodeId} → ${edge.toNodeId}` },
      )
    }

    default:
      // 模型编了不存在的工具名：明确拒绝，而不是悄悄忽略
      return fail(`没有名为 ${name} 的工具`)
  }
}

export interface AgentRunInput {
  readonly message: string
  readonly history: readonly { role: 'user' | 'assistant'; text: string }[]
}

export interface AgentRunResult {
  readonly reply: string
  readonly changes: readonly CanvasChange[]
  readonly rounds: number
  /** 实际回答问题的模型标识（来自厂商响应），用来证明用的是用户自己的模型 */
  readonly model: string | null
}

/** 每个节点进上下文的产出摘要上限 */
const PER_NODE_SUMMARY = 1200
/** 每个节点进上下文的对话条数 / 字符上限 */
const PER_NODE_MESSAGES = 6
const PER_NODE_CONVERSATION = 800
/** 全部节点加起来的上限：再多会挤掉系统提示与用户问题 */
const CONTEXT_BUDGET = 16_000

export interface CanvasContext {
  /** 给模型的完整上下文（节点清单 + 产出内容 + 对话 + 连线） */
  readonly text: string
  readonly nodeCount: number
  /** 有内容被截断的节点数：截断时提示模型可以调 read_node_output 看全文 */
  readonly truncated: number
}

/**
 * 画布上下文：**把所有节点及其内容一起交给模型**。
 *
 * 之前只给"标题 + 状态"，模型要回答"这个概念怎么理解"时必须自己调工具去读；
 * 读不读、读几个，全看它心情 —— 用户要的是"以全部卡片及其内容为上下文"，
 * 那就必须**主动**把内容放进去，工具只是补全细节的手段。
 *
 * 预算按节点均分：节点少时每个能读全文，节点多时按比例截断，
 * 并在结尾明确写"哪些被截断了"，而不是悄悄丢内容。
 */
export async function buildCanvasContext(deps: AgentDeps): Promise<CanvasContext> {
  const [nodes, edges] = await Promise.all([
    deps.prisma.node.findMany({
      where: { canvasId: deps.canvasId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, type: true, title: true, status: true },
    }),
    deps.prisma.edge.findMany({
      where: { canvasId: deps.canvasId },
      select: { fromNodeId: true, toNodeId: true },
    }),
  ])
  if (nodes.length === 0) return { text: '（空画布）', nodeCount: 0, truncated: 0 }

  const ids = nodes.map((node) => node.id)
  const [artifacts, messages] = await Promise.all([
    deps.prisma.artifact.findMany({
      where: { nodeId: { in: ids } },
      orderBy: { createdAt: 'desc' },
      select: { nodeId: true, kind: true, structured: true },
    }),
    deps.prisma.nodeMessage.findMany({
      where: { nodeId: { in: ids } },
      orderBy: { createdAt: 'asc' },
      select: { nodeId: true, role: true, content: true },
    }),
  ])

  const latest = new Map<string, { kind: string; structured: unknown }>()
  for (const artifact of artifacts) {
    if (!latest.has(artifact.nodeId)) latest.set(artifact.nodeId, { kind: artifact.kind, structured: artifact.structured })
  }
  const conversation = new Map<string, string[]>()
  for (const message of messages) {
    const list = conversation.get(message.nodeId) ?? []
    list.push(`${message.role === 'user' ? '用户' : '助手'}：${message.content.replace(/\s+/g, ' ').trim()}`)
    conversation.set(message.nodeId, list)
  }

  // 节点越多，每个分到的预算越小，但不少于 400 字，保证还能看出在讲什么
  const perNode = Math.max(400, Math.min(PER_NODE_SUMMARY, Math.floor(CONTEXT_BUDGET / nodes.length) - 300))
  const nameOf = new Map(nodes.map((node) => [node.id, node.title ?? node.type]))
  const blocks: string[] = []
  let budget = CONTEXT_BUDGET
  let truncated = 0

  for (const node of nodes) {
    const artifact = latest.get(node.id)
    const summary = artifact ? summarizeArtifact(artifact.kind, artifact.structured) : ''
    const clippedSummary = summary.length > perNode ? `${summary.slice(0, perNode)}…（已截断，可调 read_node_output 看全文）` : summary
    if (summary.length > perNode) truncated += 1

    const talk = (conversation.get(node.id) ?? []).slice(-PER_NODE_MESSAGES).join('\n')
    const clippedTalk = talk.length > PER_NODE_CONVERSATION ? `${talk.slice(0, PER_NODE_CONVERSATION)}…` : talk

    const block =
      `### ${node.type}｜${node.title ?? node.type}｜${node.status}｜id=${node.id}\n` +
      (artifact ? `产物（${artifact.kind}）：\n${clippedSummary || '（空）'}\n` : '尚未运行，没有产物\n') +
      (clippedTalk ? `对话：\n${clippedTalk}\n` : '')

    if (budget - block.length < 0) {
      truncated += 1
      break
    }
    budget -= block.length
    blocks.push(block)
  }

  const edgeLines = edges.map(
    (edge) => `- ${nameOf.get(edge.fromNodeId) ?? edge.fromNodeId} → ${nameOf.get(edge.toNodeId) ?? edge.toNodeId}`,
  )

  return {
    text:
      `节点与内容（共 ${nodes.length} 个）：\n\n${blocks.join('\n')}\n` +
      (edgeLines.length > 0 ? `连线：\n${edgeLines.join('\n')}\n` : '连线：无\n') +
      (truncated > 0 ? `\n（有 ${truncated} 个节点的内容因长度被截断；需要细节时调 read_node_output 读全文）` : ''),
    nodeCount: nodes.length,
    truncated,
  }
}

const SYSTEM_RULES = [
  '你是 StudyGraph 画布上的学习助手 + 操作助手。',
  '',
  '你有两件事要做：',
  '· **回答问题**：用户问的任何问题都可以回答。关于画布的问题，优先依据下面给出的全部节点内容；',
  '  问到画布之外的知识，就用你本身的知识正常回答，但要说明"这部分不在画布内容里"。不要拒答，不要只回"画布上没有"。',
  '· **操作画布**：通过工具建节点、连线、改提示词、整理布局。',
  '',
  '下面「当前画布」里已经包含**每个节点的产出内容与最近对话**，是你回答画布问题的首要依据；',
  '内容被标注截断时，再调 read_node_output 读全文。',
  '',
  '规则（按重要性排序）：',
  '1. 用户让你建图、改图、删东西时，**直接用工具做**，不要只给建议，也不要说"你可以自己建"。做完用一两句话说明改了什么。',
  '2. 回答画布相关问题时，引用节点里的具体内容（概念名、定义、题目），不要泛泛而谈；内容里确实没有就直说没有，不要编造引文。',
  '3. 只有用户明确要求删除时才调用 delete_node / delete_edge。',
  '4. 不要重复创建用户已经有的节点类型，除非用户明确要求。',
  '4a. 用户要"知识卡"时，如果画布上已有概念抽取节点且跑过，用 split_cards 按概念拆成一概念一节点；不要建一个塞满所有卡的单节点。',
  '4b. DEEPEN（深入理解）只接受知识卡与题目的连线；LECTURE（导出讲义）接受任意节点产出，用来汇总成讲义。',
  '5. **永远不要执行节点**（不要假装运行）——运行只能由用户点节点上的 ▶。',
  '6. 不许编造 id：只用 list_canvas / 上面状态里给出的 id。工具报错就照错误信息修正，不要重试同样的参数。',
  '7. 回复用中文，简短、具体。',
].join('\n')

/**
 * 跑一轮 agent 循环。
 *
 * 每一步：模型要么调工具（执行、回灌），要么给出最终答复（结束）。
 * 最多 6 轮 —— 再多基本意味着模型在绕圈，继续跑只是烧钱。
 */
export async function runCanvasAgent(
  llm: LLMGateway,
  deps: AgentDeps,
  input: AgentRunInput,
): Promise<AgentRunResult> {
  // 全部节点及其产出、对话一起交给模型：这是"以全部卡片及其内容为上下文"的落点
  const context = await buildCanvasContext(deps)
  const messages: AgentMessage[] = [
    { role: 'system', content: `${SYSTEM_RULES}\n\n当前画布（含全部节点内容）：\n${context.text}` },
    ...input.history.slice(-6).map((turn) => ({ role: turn.role, content: turn.text }) as AgentMessage),
    { role: 'user', content: input.message },
  ]

  const changes: CanvasChange[] = []
  let lastText = ''
  let model: string | null = null

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const result = await llm.chatWithTools({
      // 独立的任务类型：学生在「模型供应商」里能单独给底部对话指定模型
      taskType: 'assistant',
      messages,
      tools: CANVAS_TOOLS,
      user: { id: deps.userId } as never,
      maxTokens: 4096,
    })

    await deps.prisma.usageRecord.create({
      data: {
        userId: deps.userId,
        canvasId: deps.canvasId,
        surface: 'CHAT_COMPLETIONS',
        provider: result.provider,
        model: result.modelVersion,
        tokensIn: result.usage.tokensIn,
        tokensOut: result.usage.tokensOut,
        cachedTokens: result.usage.cachedTokens,
      },
    })

    lastText = result.content.trim()
    model = result.modelVersion

    // 没有工具调用 = 模型认为事情办完了
    if (result.toolCalls.length === 0) {
      return {
        reply: lastText.length > 0 ? lastText : summarizeChanges(changes),
        changes,
        rounds: round + 1,
        model,
      }
    }

    messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls })

    for (const call of result.toolCalls) {
      const outcome = await executeCanvasTool(deps, call.name, call.arguments)
      if (outcome.change) changes.push(outcome.change)
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(outcome.result).slice(0, TOOL_RESULT_LIMIT),
      })
    }
  }

  return {
    reply:
      lastText.length > 0
        ? lastText
        : `这一轮工具调用达到上限（${MAX_TOOL_ROUNDS} 次），先停在这里。已经改动 ${changes.length} 处，你可以让我继续。`,
    changes,
    model,
    rounds: MAX_TOOL_ROUNDS,
  }
}

function summarizeChanges(changes: readonly CanvasChange[]): string {
  if (changes.length === 0) return '这一轮没有改动画布。'
  return `已改动画布 ${changes.length} 处：${changes.map((change) => change.label).join('、')}`
}
