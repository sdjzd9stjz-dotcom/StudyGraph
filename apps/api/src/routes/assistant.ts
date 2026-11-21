import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { NODE_TYPES, isNodeType } from '../../../../packages/contracts/src/index.ts'
import type { NodeType } from '../../../../packages/contracts/src/index.ts'
import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import type { LLMGateway } from '../llm/types.ts'
import { summarizeArtifact } from '../domain/artifact-text.ts'
import { requireCanvasWrite } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

/**
 * 底部 AI 对话栏（用户 2026-11-21 要求）。
 *
 * 它能做三件事，**都不能自动执行节点**（硬约束 2）：
 *   1. 读画布现状，回答"我现在到哪一步了"
 *   2. 提议要建哪些节点、怎么连线 → 返回**草案**，用户点「应用到画布」才落地
 *   3. 提议给某个节点绑定 skill
 *
 * 关键设计：**没有模型密钥时降级到离线规则引擎**。
 * 理由不是"凑合"，而是：新建画布的第一步就是"我想把课件变成知识卡"，
 * 这句需求是确定的、可枚举的，用关键词就能映射成一条标准链。
 * 让它依赖密钥，等于让新用户在第一步就卡住。
 */

const bodySchema = z.object({
  message: z.string().trim().min(1).max(2000),
  /** 最近几轮对话：模型要知道"再"指的是什么 */
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) }))
    .max(20)
    .optional(),
})

/** 标准知识链：新手最常要的东西，离线也能建 */
const PANEL_CHAIN: Array<{ type: NodeType; title: string }> = [
  { type: 'SOURCE', title: '课件' },
  { type: 'CHUNK', title: '切片' },
  { type: 'EXTRACT', title: '概念抽取' },
  { type: 'CARD', title: '知识卡' },
  { type: 'PREREQ', title: '先修关系' },
]

interface Action {
  readonly kind: 'create-node' | 'create-edge' | 'bind-skill' | 'review'
  readonly payload: Record<string, unknown>
}

/** 关键词 → 节点类型。用户说人话，这里翻成结构。 */
const KEYWORD_NODES: Array<{ pattern: RegExp; type: NodeType; title: string }> = [
  { pattern: /课件|文件|上传|幻灯|pdf|ppt/i, type: 'SOURCE', title: '课件' },
  { pattern: /切片|分段|切块/i, type: 'CHUNK', title: '切片' },
  { pattern: /抽取|概念|知识点|提炼/i, type: 'EXTRACT', title: '概念抽取' },
  { pattern: /知识卡|卡片|建卡/i, type: 'CARD', title: '知识卡' },
  { pattern: /先修|前置|依赖|顺序/i, type: 'PREREQ', title: '先修关系' },
  { pattern: /复习|记忆|背诵|到期/i, type: 'REVIEW', title: '复习调度' },
  { pattern: /题型|考点|识别/i, type: 'PROBE', title: '题型识别' },
  { pattern: /解法|方法|套路/i, type: 'METHOD', title: '解法抽取' },
  { pattern: /分步|讲解|演示/i, type: 'SOLVE', title: '分步解法' },
  { pattern: /错因|为什么错|诊断/i, type: 'DIAGNOSE', title: '错因归因' },
  { pattern: /出题|题目|练习/i, type: 'QUIZ', title: '出题' },
]

/**
 * 整张图的布局（照 ComfyUI 的读法：从左往右、按支线分层）。
 *
 * x 越大越靠下游；y 把不同支线分开，这样落到画布上就是一张能直接看懂的知识地图，
 * 而不是一堆叠在原点的方块。
 */
const GRAPH_NODES: Array<{ type: NodeType; title: string; x: number; y: number }> = [
  // 主链
  { type: 'SOURCE', title: '课件', x: 60, y: 240 },
  { type: 'CHUNK', title: '切片', x: 340, y: 240 },
  { type: 'EXTRACT', title: '概念抽取', x: 620, y: 240 },
  { type: 'CARD', title: '知识卡', x: 900, y: 240 },
  // 知识组织
  { type: 'PREREQ', title: '先修关系', x: 1180, y: 140 },
  { type: 'REVIEW', title: '复习调度', x: 1180, y: 300 },
  { type: 'GATE', title: '人工闸门', x: 1180, y: 460 },
  // 出题支链
  { type: 'QUIZ', title: '出题', x: 1180, y: -60 },
  { type: 'CHECK', title: '质量闸门', x: 1460, y: -60 },
  { type: 'PAPER', title: '组卷', x: 1740, y: -60 },
  // 解题支链
  { type: 'PROBE', title: '题型识别', x: 340, y: 620 },
  { type: 'METHOD', title: '解法抽取', x: 620, y: 620 },
  { type: 'SOLVE', title: '分步解法', x: 900, y: 620 },
  { type: 'DIAGNOSE', title: '错因归因', x: 1180, y: 620 },
]

const GRAPH_EDGES: Array<{ from: NodeType; to: NodeType }> = [
  { from: 'SOURCE', to: 'CHUNK' },
  { from: 'CHUNK', to: 'EXTRACT' },
  { from: 'EXTRACT', to: 'CARD' },
  { from: 'CARD', to: 'PREREQ' },
  { from: 'CARD', to: 'REVIEW' },
  { from: 'CARD', to: 'GATE' },
  { from: 'CARD', to: 'QUIZ' },
  { from: 'QUIZ', to: 'CHECK' },
  { from: 'CHECK', to: 'PAPER' },
  { from: 'SOURCE', to: 'PROBE' },
  { from: 'PROBE', to: 'METHOD' },
  { from: 'METHOD', to: 'SOLVE' },
  { from: 'SOLVE', to: 'DIAGNOSE' },
]

/** 每条支链需要的节点（用于按意图裁剪） */
const BRANCH_QUIZ: NodeType[] = ['QUIZ', 'CHECK', 'PAPER']
const BRANCH_SOLVE: NodeType[] = ['PROBE', 'METHOD', 'SOLVE', 'DIAGNOSE']
const CORE: NodeType[] = ['SOURCE', 'CHUNK', 'EXTRACT', 'CARD', 'PREREQ', 'REVIEW']

/**
 * 规划整张图。
 *
 * 用户明确要求过"不要一次只给一步" —— 所以默认就是**整张图**：
 * 主链 + 出题 + 解题 + 闸门，一次铺完。只有当他说的是具体某几个节点时，
 * 才只给主链加那几个。
 *
 * 与画布现状比对：已有的类型不重复建，但**连线照样补上** ——
 * 多轮对话里第二轮只新增一个节点，它和已有节点之间的线也必须连起来。
 */
function planGraph(message: string, existing: readonly { type: string }[]): { reply: string; actions: Action[] } {
  const existingTypes = new Set(existing.map((node) => node.type))
  const asked = KEYWORD_NODES.filter((entry) => entry.pattern.test(message)).map((entry) => entry.type)

  const wantsFull = /完整|全部|整张|全流程|整条|从头|整图/.test(message) || asked.length === 0
  const wantsQuiz = wantsFull || /出题|题|练习|组卷|考试|卷子/.test(message)
  const wantsSolve = wantsFull || /解题|方法|步骤|错因|讲解|例题/.test(message)

  /**
   * 裁剪规则：
   *   · 全图 → 全部
   *   · 只点了几个节点 → 主链 + 那几个（图必须能连起来，孤立节点没用）
   */
  const wanted = new Set<NodeType>(wantsFull ? CORE : [...CORE, ...asked])
  if (wantsFull || wantsQuiz) for (const type of BRANCH_QUIZ) wanted.add(type)
  if (wantsFull || wantsSolve) for (const type of BRANCH_SOLVE) wanted.add(type)
  // 用户点名了主链之外的节点，就把它加进来
  for (const type of asked) wanted.add(type)

  const actions: Action[] = []
  const added: NodeType[] = []

  for (const node of GRAPH_NODES) {
    if (!wanted.has(node.type)) continue
    if (existingTypes.has(node.type)) continue
    actions.push({
      kind: 'create-node',
      payload: { type: node.type, title: node.title, ref: node.type, pos: { x: node.x, y: node.y } },
    })
    added.push(node.type)
  }

  // 连线：两端都必须「本来就有」或「这次会建」
  const available = new Set<NodeType>([...existingTypes, ...added] as NodeType[])
  for (const edge of GRAPH_EDGES) {
    if (!wanted.has(edge.from) || !wanted.has(edge.to)) continue
    if (!available.has(edge.from) || !available.has(edge.to)) continue
    actions.push({ kind: 'create-edge', payload: { from: edge.from, to: edge.to } })
  }

  if (/溯源|引文|出处|严格/i.test(message)) {
    actions.push({ kind: 'bind-skill', payload: { skillSlug: 'citation-strict', nodeType: 'EXTRACT' } })
  }

  const edgeCount = actions.filter((action) => action.kind === 'create-edge').length
  const reply = added.length === 0
    ? `画布上已经有这些节点了${edgeCount > 0 ? `，我会补 ${edgeCount} 条连线` : ''}。` +
      '要再调整什么直接说；想开始就点节点上的 ▶ —— **我不会替你运行任何节点**。'
    : `我给你铺一张完整的图：新增 ${added.length} 个节点、${edgeCount} 条连线` +
      `（${added.map((type) => GRAPH_NODES.find((node) => node.type === type)?.title ?? type).join('、')}）。` +
      '确认后全部以草稿状态落地，**不会自动执行** —— 每一步都要你自己点 ▶。'

  return { reply, actions }
}

/**
 * 像不像"提问"而不是"让我建图"。
 *
 * 故意保守：带问号，或以疑问词开头/收尾才算。
 * "把课件做成知识卡"、"再加一条解题支线" 这类祈使句不会被误判成提问。
 */
export function looksLikeQuestion(message: string): boolean {
  const text = message.trim()
  if (text.length === 0) return false
  if (/[?？]/.test(text)) return true
  return /^(为什么|为啥|怎么|如何|什么|哪些|哪个|是不是|能否|可不可以|有没有|解释|讲讲|说说|总结|梳理|看看)/.test(text)
}

/** 每个节点最多取这么多字进上下文：再多模型也读不完，还会挤掉别的节点 */
const EXCERPT_PER_NODE = 1400
/** 全部节点加起来的上限 */
const EXCERPT_TOTAL = 14_000

interface NodeBrief {
  readonly id: string
  readonly type: string
  readonly title: string | null
  readonly status: string
}

/**
 * 就节点里的内容回答问题。
 *
 * 它读的是**每个节点最近一次运行的产物**（Artifact.structured），
 * 也就是你在界面上看到的那份东西 —— 不是模型凭印象编。
 *
 * 没有模型密钥时退化成"结构化回答"：告诉画布上有什么、到哪一步了、
 * 哪些节点还没跑。这类问题不需要模型也能答，且不会花钱。
 */
async function answerAboutNodes(
  prisma: PrismaClient,
  canvasId: string,
  nodes: readonly NodeBrief[],
  question: string,
  llm: LLMGateway,
  user: { id: string },
): Promise<{ reply: string; source: 'model' | 'offline' }> {
  if (nodes.length === 0) {
    return {
      reply: '画布上还没有节点，所以没有内容可查。先上传课件或让我铺一张图，跑出结果之后再问我。',
      source: 'offline',
    }
  }

  // 每个节点取最近一次产物
  const artifacts = await prisma.artifact.findMany({
    where: { nodeId: { in: nodes.map((node) => node.id) } },
    orderBy: { createdAt: 'desc' },
    select: { nodeId: true, kind: true, structured: true, createdAt: true },
  })
  const latest = new Map<string, { kind: string; structured: unknown }>()
  for (const artifact of artifacts) {
    if (latest.has(artifact.nodeId)) continue
    latest.set(artifact.nodeId, { kind: artifact.kind, structured: artifact.structured })
  }

  const ran = nodes.filter((node) => latest.has(node.id))
  const unrun = nodes.filter((node) => !latest.has(node.id))

  // 一个产物都没有：不需要模型，直接说清现状
  if (ran.length === 0) {
    return {
      reply:
        `画布上有 ${nodes.length} 个节点，但**都还没跑过**，没有内容可查。\n` +
        `节点：${nodes.map((node) => `${node.title ?? node.type}（${node.status}）`).join('、')}\n\n` +
        '先点节点上的 ▶ 跑出结果，再问我里面的内容。',
      source: 'offline',
    }
  }

  let budget = EXCERPT_TOTAL
  const sections: string[] = []
  for (const node of ran) {
    const artifact = latest.get(node.id)!
    const raw = JSON.stringify(artifact.structured ?? null)
    const excerpt = raw.length > EXCERPT_PER_NODE ? `${raw.slice(0, EXCERPT_PER_NODE)}…（已截断）` : raw
    if (budget - excerpt.length < 0) break
    budget -= excerpt.length
    sections.push(`### 节点「${node.title ?? node.type}」（类型 ${node.type}，产物 ${artifact.kind}）\n${excerpt}`)
  }

  try {
    const result = await llm.complete({
      taskType: 'method',
      messages: [
        {
          role: 'system',
          content:
            '你在回答用户关于他自己画布的问题。下面是各节点最近一次运行的产物内容。\n' +
            '规则：\n' +
            '1. 只依据下面给出的内容回答，不要补充这些内容里没有的知识\n' +
            '2. 回答时点名是哪个节点的内容（例如「知识卡节点里」）\n' +
            '3. 内容里没有答案就直接说"画布里没有这个信息"，并指出哪个节点应该会有\n' +
            '4. 不要建议执行任何节点，也不要编造引文\n\n' +
            (unrun.length > 0
              ? `还没跑过的节点：${unrun.map((node) => node.title ?? node.type).join('、')}（它们没有内容可查）\n\n`
              : '') +
            sections.join('\n\n'),
        },
        { role: 'user', content: question },
      ],
      user: user as never,
    })

    await prisma.usageRecord.create({
      data: {
        userId: user.id,
        canvasId,
        surface: 'CHAT_COMPLETIONS',
        provider: result.provider,
        model: result.modelVersion,
        tokensIn: result.usage.tokensIn,
        tokensOut: result.usage.tokensOut,
        cachedTokens: result.usage.cachedTokens,
      },
    })

    const text = (result.data as { reply?: string } | undefined)?.reply
    return {
      reply: typeof text === 'string' && text.trim().length > 0 ? text : '模型没有返回内容，换个问法再试一次。',
      source: 'model',
    }
  } catch (error) {
    // 没配密钥 / 厂商不通：退化成结构化回答，别把"没密钥"报成一个吓人的错误
    const reason = error instanceof Error ? error.message : String(error)
    return {
      reply:
        `现在还不能就内容回答（${reason}）。\n\n` +
        `不过画布现状是：${ran.length} 个节点有产物、${unrun.length} 个还没跑。\n` +
        `有内容的：${ran.map((node) => node.title ?? node.type).join('、')}\n` +
        (unrun.length > 0 ? `没跑的：${unrun.map((node) => node.title ?? node.type).join('、')}\n` : '') +
        '\n配好模型密钥（「模型供应商」页面）之后，我就能直接读这些内容回答你。',
      source: 'offline',
    }
  }
}

/**
 * 单节点对话：每个节点自己就是一个会话。
 *
 * 与画布级提问的区别：这里**只给这一个节点的产物**当上下文，
 * 所以问"这段推导为什么成立"会得到贴着这份内容的回答，而不是泛泛而过。
 *
 * 没跑过的节点没有内容可谈 —— 直接说清楚，不要凭空聊。
 */
function registerNodeChat(app: FastifyInstance, deps: AssistantRouteDeps): void {
  const { prisma, guard, llm } = deps

  app.post('/v1/nodes/:id/chat', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const body = parse(
      z.object({
        message: z.string().trim().min(1).max(2000),
        history: z
          .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) }))
          .max(20)
          .optional(),
      }),
      request.body,
    )

    const node = await prisma.node.findUnique({
      where: { id },
      select: { id: true, canvasId: true, type: true, title: true },
    })
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', '节点不存在', { nodeId: id })
    await requireCanvasWrite(prisma, node.canvasId, auth.user.id)

    const artifact = await prisma.artifact.findFirst({
      where: { nodeId: id },
      orderBy: { createdAt: 'desc' },
      select: { kind: true, structured: true },
    })

    const card = artifact ? summarizeArtifact(artifact.kind, artifact.structured) : ''
    const label = node.title ?? node.type

    if (!artifact) {
      return reply.status(200).send({
        reply: `「${label}」这个节点还没跑过，没有内容可以讨论。先点节点上的 ▶ 跑一次，我就能就它的结果和你聊。`,
        output: null,
        source: 'offline',
      })
    }

    try {
      const result = await llm.complete({
        taskType: 'method',
        messages: [
          {
            role: 'system',
            content:
              `你在和用户讨论他画布上「${label}」这个节点的内容。下面就是这个节点最近一次运行的产出：\n\n` +
              `${card.slice(0, 12_000)}\n\n` +
              '规则：\n' +
              '1. 只依据上面的内容回答，不要补充内容里没有的知识\n' +
              '2. 解释要具体到内容里的条目，别讲空话\n' +
              '3. 内容里没有答案就说"这个节点的产出里没有"，并说明需要哪个节点提供\n' +
              '4. 不要建议执行节点，不要编造引文',
          },
          ...(body.history ?? []).map((turn) => ({ role: turn.role, content: turn.text })),
          { role: 'user', content: body.message },
        ],
        user: auth.user,
      })

      await prisma.usageRecord.create({
        data: {
          userId: auth.user.id,
          canvasId: node.canvasId,
          surface: 'CHAT_COMPLETIONS',
          provider: result.provider,
          model: result.modelVersion,
          tokensIn: result.usage.tokensIn,
          tokensOut: result.usage.tokensOut,
          cachedTokens: result.usage.cachedTokens,
        },
      })

      const text = (result.data as { reply?: string } | undefined)?.reply
      return reply.status(200).send({
        reply: typeof text === 'string' && text.trim().length > 0 ? text : '模型没有返回内容，换个问法再试一次。',
        output: card,
        source: 'model',
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return reply.status(200).send({
        reply:
          `现在还不能就内容回答（${reason}）。\n\n` +
          '这个节点的产出是：\n' +
          card.slice(0, 1200) +
          '\n\n配好模型密钥后，我可以据此解释、追问、指出矛盾。',
        output: card,
        source: 'offline',
      })
    }
  })
}

/**
 * 让用户的模型来规划画布。
 *
 * 它拿到的能力就是"能建哪些节点、现在画布上有什么"，输出节点与连线 ——
 * 也就是说模型真的在用画布，而不是只写一段话。
 * 但**不能执行**：产出只是建议，落地后是 DRAFT。
 *
 * 返回 null 表示"这次没规划出可用的东西"（没有凭据、模型报错、输出为空），
 * 由调用方退回规则规划。
 */
export interface ModelPlanShape {
  readonly nodes?: ReadonlyArray<{ type?: unknown; title?: unknown }>
  readonly edges?: ReadonlyArray<{ from?: unknown; to?: unknown }>
}

/**
 * 把模型返回的规划转成可执行的动作列表。
 *
 * 三道校验，每道都对应一种会让画布变脏的模型输出：
 *   1. 类型必须是 17 个之一 —— 模型会编出不存在的节点名
 *   2. 已有的类型不重复建 —— 否则多轮对话每次都把整张图重铺一遍
 *   3. 连线两端必须存在、且不能自连 —— 否则产生断头线，画布上看不见但会污染图
 *
 * 抽成纯函数是为了能测：这段逻辑出错的表现是"模型说了但画布没变"，
 * 在界面上和"模型没被调用"完全一样，很难分辨。
 */
export function actionsFromModelPlan(plan: ModelPlanShape | undefined, existingTypes: Iterable<string>): Action[] {
  const existing = new Set(existingTypes)
  const actions: Action[] = []
  const created: NodeType[] = []
  let index = 0

  for (const node of plan?.nodes ?? []) {
    const type = node.type
    if (typeof type !== 'string' || !isNodeType(type)) continue
    if (existing.has(type)) continue
    existing.add(type)
    created.push(type)

    // 已知类型沿用思维导图布局；其它组合按列顺排，避免全叠在原点
    const preset = GRAPH_NODES.find((entry) => entry.type === type)
    const title = typeof node.title === 'string' && node.title.trim().length > 0 ? node.title.trim() : preset?.title ?? type
    actions.push({
      kind: 'create-node',
      payload: {
        type,
        title,
        ref: type,
        pos: preset ? { x: preset.x, y: preset.y } : { x: 60 + index * 280, y: 900 },
      },
    })
    index += 1
  }

  const available = new Set<string>([...existing, ...created])
  for (const edge of plan?.edges ?? []) {
    const from = edge.from
    const to = edge.to
    if (typeof from !== 'string' || typeof to !== 'string') continue
    if (!available.has(from) || !available.has(to) || from === to) continue
    actions.push({ kind: 'create-edge', payload: { from, to } })
  }

  return actions
}

async function planWithModel(
  prisma: PrismaClient,
  llm: LLMGateway,
  input: {
    canvasId: string
    nodes: readonly NodeBrief[]
    message: string
    history: readonly { role: 'user' | 'assistant'; text: string }[]
    user: { id: string }
  },
): Promise<{ reply: string; actions: Action[] } | null> {
  const existing = new Set(input.nodes.map((node) => node.type))
  const canvasState =
    input.nodes.length === 0
      ? '（空画布）'
      : input.nodes.map((node) => `${node.title ?? node.type}(${node.type}, ${node.status})`).join('、')

  try {
    const result = await llm.complete({
      taskType: 'method',
      messages: [
        {
          role: 'system',
          content:
            '你是 StudyGraph 的学习工作流助手，可以通过"摆放节点和连线"来搭建用户的画布。\n\n' +
            `当前画布：${canvasState}\n` +
            `可用节点类型：${NODE_TYPES.join(' / ')}\n\n` +
            '节点含义：\n' +
            '- SOURCE 课件（上传的文件）→ CHUNK 切片 → EXTRACT 概念抽取 → CARD 知识卡\n' +
            '- CARD → PREREQ 先修关系 / REVIEW 复习调度 / GATE 人工闸门 / QUIZ 出题 → CHECK 三检 → PAPER 组卷\n' +
            '- SOURCE → PROBE 题型识别 → METHOD 解法抽取 → SOLVE 分步解法 → DIAGNOSE 错因归因\n\n' +
            '规则：\n' +
            '1. **不要重复创建画布上已有的节点类型**（上面列出的就是已有的）\n' +
            '2. 连线只能连到"已有的或你要创建的"节点，方向是从上游到下游\n' +
            '3. 只给必要的东西：用户要什么就给什么，不要为了热闹铺满\n' +
            '4. 绝不建议或声称执行了任何节点 —— 你只负责摆放，运行由用户点 ▶\n' +
            '5. reply 用一两句话说明你摆了什么',
        },
        ...input.history.slice(-6).map((turn) => ({ role: turn.role, content: turn.text })),
        { role: 'user', content: input.message },
      ],
      jsonSchema: {
        type: 'object',
        properties: {
          reply: { type: 'string' },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', description: '必须是上面列出的节点类型之一' },
                title: { type: 'string' },
              },
              required: ['type'],
              additionalProperties: false,
            },
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              properties: { from: { type: 'string' }, to: { type: 'string' } },
              required: ['from', 'to'],
              additionalProperties: false,
            },
          },
        },
        required: ['reply', 'nodes', 'edges'],
        additionalProperties: false,
      },
      user: input.user as never,
    })

    const data = result.data as
      | { reply?: string; nodes?: Array<{ type?: string; title?: string }>; edges?: Array<{ from?: string; to?: string }> }
      | undefined

    const actions = actionsFromModelPlan(data, existing)

    await prisma.usageRecord.create({
      data: {
        userId: input.user.id,
        canvasId: input.canvasId,
        surface: 'CHAT_COMPLETIONS',
        provider: result.provider,
        model: result.modelVersion,
        tokensIn: result.usage.tokensIn,
        tokensOut: result.usage.tokensOut,
        cachedTokens: result.usage.cachedTokens,
      },
    })

    if (actions.length === 0) return null

    const replyText = typeof data?.reply === 'string' && data.reply.trim() ? data.reply.trim() : '已经按你的要求调整了画布。'
    return {
      reply: `${replyText}\n\n（落地后都是草稿，需要你逐个点 ▶ —— 我不会替你运行任何节点）`,
      actions,
    }
  } catch {
    // 没凭据 / 模型不支持 JSON / 厂商报错：交给规则规划兜底，别让对话栏变成报错栏
    return null
  }
}

export interface AssistantRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
  readonly llm: LLMGateway
}

export function registerAssistantRoutes(app: FastifyInstance, deps: AssistantRouteDeps): void {
  const { prisma, guard, llm } = deps

  registerNodeChat(app, deps)

  /**
   * 对话。返回的是**建议**，不落画布。
   * 离线规则引擎优先：需求确定时它比模型更可预测，也不花钱。
   */
  app.post('/v1/canvases/:canvasId/assistant', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { canvasId } = request.params as { canvasId: string }
    const body = parse(bodySchema, request.body)
    await requireCanvasWrite(prisma, canvasId, auth.user.id)

    const nodes = await prisma.node.findMany({
      where: { canvasId },
      select: { id: true, type: true, title: true, status: true },
    })
    const skills = await prisma.skill.findMany({
      where: { enabled: true, OR: [{ scope: 'BUILTIN' }, { scope: 'USER', ownerId: auth.user.id }] },
      select: { id: true, slug: true, name: true },
    })

    /**
     * 提问模式：问节点里的内容，而不是让你改建图。
     *
     * 判据是"像不像一个问题"。像问题就**不建节点**，直接拿产物内容回答 ——
     * 否则用户问"这个概念是什么意思"，会收到一堆新建节点的建议，答非所问。
     */
    if (looksLikeQuestion(body.message)) {
      const answer = await answerAboutNodes(prisma, canvasId, nodes, body.message, llm, auth.user)
      return reply.status(200).send({
        reply: answer.reply,
        actions: [],
        source: answer.source,
        kind: 'answer',
        canvas: { nodeCount: nodes.length },
      })
    }

    const plan = planGraph(body.message, nodes)

    /**
     * 先让**用户的模型**规划，失败才退回规则。
     *
     * 之前是反的：`plan.actions.length === 0` 才去问模型，而规则规划永远能给出
     * 一整张图 —— 于是模型从来没被调用过，用户看到的"AI"其实只是关键词匹配。
     * 现在模型是主路径，规则只在没有凭据/调用失败时兜底。
     */
    const modelActions = await planWithModel(prisma, llm, {
      canvasId,
      nodes,
      message: body.message,
      history: body.history ?? [],
      user: auth.user,
    })

    if (modelActions) {
      return reply.status(200).send({
        reply: modelActions.reply,
        actions: modelActions.actions,
        source: 'model',
        canvas: { nodeCount: nodes.length },
      })
    }

    return reply.status(200).send({ ...plan, source: 'offline', canvas: { nodeCount: nodes.length } })
  })

  /**
   * 应用建议：一次性落地节点与连线。
   *
   * 与 G1 草案的区别：草案是"一整张图"，这里是"在当前画布上补几个节点"。
   * 落地后节点是 DRAFT，**不执行**。
   */
  app.post('/v1/canvases/:canvasId/assistant/apply', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { canvasId } = request.params as { canvasId: string }
    const body = parse(
      z.object({
        actions: z.array(z.object({ kind: z.string(), payload: z.record(z.string(), z.unknown()) })).max(30),
      }),
      request.body,
    )
    await requireCanvasWrite(prisma, canvasId, auth.user.id)

    const created: Array<{ ref: string; id: string; type: string; title: string }> = []
    const edges: Array<{ from: string; to: string }> = []
    const boundSkills: string[] = []
    let x = 40

    /**
     * 画布上已有的节点也要能当连线端点。
     *
     * 多轮对话里第二轮通常只新增一两个节点，其余都"本来就有"；
     * 只认本次创建的节点，那些线会被静默丢掉，图就断了。
     */
    const existingNodes = await prisma.node.findMany({
      where: { canvasId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, type: true },
    })
    const refToId = new Map<string, string>()
    for (const node of existingNodes) {
      if (!refToId.has(node.type)) refToId.set(node.type, node.id)
    }

    // 从左到右铺开，避免新节点全叠在原点
    for (const action of body.actions) {
      if (action.kind === 'create-node') {
        const type = action.payload.type
        if (typeof type !== 'string' || !isNodeType(type)) continue
        // 规划器给了坐标就用它（整张图按支线分层）；没给就顺序铺开
        const pos = action.payload.pos as { x?: unknown; y?: unknown } | undefined
        const posX = typeof pos?.x === 'number' && Number.isFinite(pos.x) ? pos.x : x
        const posY = typeof pos?.y === 'number' && Number.isFinite(pos.y) ? pos.y : 80
        const node = await prisma.node.create({
          data: {
            canvasId,
            type,
            title: typeof action.payload.title === 'string' ? action.payload.title : null,
            params: {},
            status: 'DRAFT',
            posX,
            posY,
          },
          select: { id: true, type: true, title: true },
        })
        if (pos === undefined) x += 300
        // 新节点也要能被后续的连线引用到
        if (!refToId.has(node.type)) refToId.set(node.type, node.id)
        created.push({ ref: String(action.payload.ref ?? type), id: node.id, type: node.type, title: node.title ?? node.type })
      } else if (action.kind === 'create-edge') {
        edges.push({ from: String(action.payload.from), to: String(action.payload.to) })
      } else if (action.kind === 'bind-skill') {
        const slug = String(action.payload.skillSlug ?? '')
        const nodeType = String(action.payload.nodeType ?? '')
        const skill = await prisma.skill.findFirst({
          where: { slug, OR: [{ scope: 'BUILTIN' }, { scope: 'USER', ownerId: auth.user.id }] },
          select: { id: true },
        })
        const target = created.find((node) => node.type === nodeType)
        if (skill && target) {
          await prisma.nodeSkill.upsert({
            where: { nodeId_skillId: { nodeId: target.id, skillId: skill.id } },
            create: { nodeId: target.id, skillId: skill.id },
            update: {},
          })
          boundSkills.push(`${target.title} ↔ ${slug}`)
        }
      }
    }

    // 连线：两端都用 ref 找。ref 先按类型命中「本来就有 / 本次新建」的节点
    const byRef = new Map(refToId)
    for (const node of created) byRef.set(node.ref, node.id)
    let edgeCount = 0
    for (const edge of edges) {
      const from = byRef.get(edge.from)
      const to = byRef.get(edge.to)
      if (!from || !to || from === to) continue
      try {
        await prisma.edge.create({
          data: { canvasId, fromNodeId: from, toNodeId: to, kind: 'DERIVED_FROM' },
        })
        edgeCount += 1
      } catch {
        // 端口/唯一约束不合法就跳过这条边，不整体失败
      }
    }

    return reply.status(201).send({
      nodes: created.length,
      edges: edgeCount,
      boundSkills,
      // 明确：没有执行任何东西
      executed: false,
    })
  })
}
