import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { NODE_TYPES, isNodeType } from '../../../../packages/contracts/src/index.ts'
import type { NodeType } from '../../../../packages/contracts/src/index.ts'
import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import type { LLMGateway } from '../llm/types.ts'
import { requireCanvasWrite } from '../lib/access.ts'
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

/** 离线策略：只做确定性、可解释的推断 */
function offlinePlan(message: string, existing: readonly { type: string }[]): { reply: string; actions: Action[] } {
  const existingTypes = new Set(existing.map((node) => node.type))
  const asked = KEYWORD_NODES.filter((entry) => entry.pattern.test(message))

  // "整条链"/"全流程"/空画布 → 给标准链
  const wantsWholeChain = /整条链|全流程|从头|全部|完整|一条链/.test(message) || (message.length < 8 && existing.length === 0)
  const wanted = wantsWholeChain || asked.length === 0 ? PANEL_CHAIN : asked

  const missing = wanted.filter((entry) => !existingTypes.has(entry.type))
  const actions: Action[] = []
  let prevKey: string | null = null

  // 只补缺的节点：画布上已经有的不重复建
  for (const entry of missing) {
    actions.push({ kind: 'create-node', payload: { type: entry.type, title: entry.title, ref: entry.type } })
    if (prevKey) actions.push({ kind: 'create-edge', payload: { from: prevKey, to: entry.type } })
    prevKey = entry.type
  }

  // 要求"严格溯源"时顺带提议绑定 skill
  if (/溯源|引文|出处|严格/i.test(message)) {
    actions.push({ kind: 'bind-skill', payload: { skillSlug: 'citation-strict', nodeType: 'EXTRACT' } })
  }

  const reply = actions.length === 0
    ? '画布上已经有这条流程需要的节点了。需要我改动什么，或者直接点节点上的「运行」开始？'
    : `我建议${missing.length}个节点：${missing.map((entry) => entry.title).join(' → ')}。` +
      (actions.some((a) => a.kind === 'bind-skill') ? '另外给概念抽取绑定「严格溯源」。' : '') +
      '确认后它们会以草稿状态放上画布，**不会自动执行**——需要你逐个点运行。'

  return { reply, actions }
}

export interface AssistantRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
  readonly llm: LLMGateway
}

export function registerAssistantRoutes(app: FastifyInstance, deps: AssistantRouteDeps): void {
  const { prisma, guard, llm } = deps

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

    const plan = offlinePlan(body.message, nodes)

    // 离线规划已经把意图识别清楚了，就不必再花一次模型调用。
    // 只有它什么也没认出来（actions 为空且用户说了不少话）时才去问模型。
    const needsModel = plan.actions.length === 0 && body.message.length > 12
    if (!needsModel) {
      return reply.status(200).send({ ...plan, source: 'offline', canvas: { nodeCount: nodes.length } })
    }

    let modelActions: Action[] = []
    let modelReply = plan.reply
    try {
      const result = await llm.complete({
        taskType: 'method',
        messages: [
          {
            role: 'system',
            content: `你是学习工作流助手。当前画布有这些节点：${
              nodes.map((node) => `${node.title ?? node.type}(${node.type},${node.status})`).join('、') || '空'
            }。
可用节点类型：${NODE_TYPES.join(' / ')}。
用一句话回复，并给出要新建的节点类型列表。不要建议自动执行任何节点。`,
          },
          { role: 'user', content: body.message },
        ],
        jsonSchema: {
          type: 'object',
          properties: {
            reply: { type: 'string' },
            nodeTypes: { type: 'array', items: { type: 'string' } },
          },
          required: ['reply', 'nodeTypes'],
          additionalProperties: false,
        },
        user: auth.user,
      })

      const data = result.data as { reply?: string; nodeTypes?: string[] }
      modelReply = data.reply ?? plan.reply
      let prevKey: string | null = null
      for (const type of data.nodeTypes ?? []) {
        if (!isNodeType(type)) continue
        modelActions.push({ kind: 'create-node', payload: { type, title: type, ref: type } })
        if (prevKey) modelActions.push({ kind: 'create-edge', payload: { from: prevKey, to: type } })
        prevKey = type
      }

      await prisma.usageRecord.create({
        data: {
          userId: auth.user.id,
          canvasId,
          surface: 'CHAT_COMPLETIONS',
          provider: result.provider,
          model: result.modelVersion,
          tokensIn: result.usage.tokensIn,
          tokensOut: result.usage.tokensOut,
          cachedTokens: result.usage.cachedTokens,
        },
      })
    } catch {
      // 模型不可用不是错误：离线规划已经给过答复了
    }

    return reply.status(200).send({
      reply: modelReply,
      actions: modelActions,
      source: modelActions.length > 0 ? 'model' : 'offline',
      canvas: { nodeCount: nodes.length },
      skills: skills.map((skill) => ({ slug: skill.slug, name: skill.name })),
    })
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

    // 从左到右铺开，避免新节点全叠在原点
    for (const action of body.actions) {
      if (action.kind === 'create-node') {
        const type = action.payload.type
        if (typeof type !== 'string' || !isNodeType(type)) continue
        const node = await prisma.node.create({
          data: {
            canvasId,
            type,
            title: typeof action.payload.title === 'string' ? action.payload.title : null,
            params: {},
            status: 'DRAFT',
            posX: x,
            posY: 80,
          },
          select: { id: true, type: true, title: true },
        })
        x += 300
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

    // 连线：两端都用 ref 找
    const byRef = new Map(created.map((node) => [node.ref, node.id]))
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
