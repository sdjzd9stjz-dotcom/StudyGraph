import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import type { LLMGateway } from '../llm/types.ts'
import { summarizeArtifact } from '../domain/artifact-text.ts'
import { requireCanvasWrite } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'
import { runCanvasAgent } from './assistant-agent.ts'

/**
 * 底部 AI 对话栏（2026-11-21 改版）。
 *
 * **由用户自己的模型驱动，不再有"离线规则引擎"兜底。**
 * 之前那条路径的毛病：用户看到的"AI"其实是一组关键词正则，
 * 它能铺图，但不会回答、不会改单个节点、也不会说明自己做了什么。
 *
 * 现在模型拿到一套只作用于画布的工具（见 assistant-agent.ts）：
 * 查看画布、读节点产出、建/改/删节点与连线，由服务端执行。
 * 模型自己决定调哪个工具，改完直接生效 —— 没有"点应用"这一步。
 *
 * 边界（硬约束）：
 *   · 不能执行节点：运行会花掉模型额度，必须由用户点 ▶
 *   · 工具只碰画布：没有文件、网络、命令
 *   · 模型不可用时**明确报错**，不伪装成"AI 的回答"
 */

const bodySchema = z.object({
  message: z.string().trim().min(1).max(2000),
  /** 最近几轮对话：模型要知道"再"指的是什么 */
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) }))
    .max(20)
    .optional(),
})

export interface AssistantRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
  readonly llm: LLMGateway
}

/**
 * 单节点对话：每个节点自己就是一个会话。
 *
 * 与画布级对话的区别：这里**只给这一个节点的产物**当上下文，
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

    /**
     * 对话落库（用户 2026-11-21 要求：连线 = 上游对话总结作为下游上下文）。
     *
     * 先把用户这句写进去：模型失败时这段对话也还在，不会因为一次 401 就丢。
     * 历史一律从库里取，不再信任客户端回传的 history —— 客户端有、服务端没有的话，
     * 同一条对话在"节点里"和"下游提示词里"会长得不一样。
     */
    await prisma.nodeMessage.create({ data: { nodeId: id, role: 'user', content: body.message } })
    const recent = await prisma.nodeMessage.findMany({
      where: { nodeId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { role: true, content: true },
    })
    const history = recent.reverse()

    const artifact = await prisma.artifact.findFirst({
      where: { nodeId: id },
      orderBy: { createdAt: 'desc' },
      select: { kind: true, structured: true },
    })

    const card = artifact ? summarizeArtifact(artifact.kind, artifact.structured) : ''
    const label = node.title ?? node.type

    if (!artifact) {
      const replyText = `「${label}」这个节点还没跑过，没有内容可以讨论。先点节点上的 ▶ 跑一次，我就能就它的结果和你聊。`
      await prisma.nodeMessage.create({ data: { nodeId: id, role: 'assistant', content: replyText } })
      return reply.status(200).send({
        reply: replyText,
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
          ...history.map((turn) => ({ role: turn.role as 'user' | 'assistant', content: turn.content })),
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
      const replyText = typeof text === 'string' && text.trim().length > 0 ? text : '模型没有返回内容，换个问法再试一次。'
      await prisma.nodeMessage.create({ data: { nodeId: id, role: 'assistant', content: replyText } })
      return reply.status(200).send({
        reply: replyText,
        output: card,
        source: 'model',
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const replyText =
        `现在还不能就内容回答（${reason}）。\n\n` +
        '这个节点的产出是：\n' +
        card.slice(0, 1200) +
        '\n\n配好模型密钥后，我可以据此解释、追问、指出矛盾。'
      await prisma.nodeMessage.create({ data: { nodeId: id, role: 'assistant', content: replyText } })
      return reply.status(200).send({
        reply: replyText,
        output: card,
        source: 'offline',
      })
    }
  })
}

export function registerAssistantRoutes(app: FastifyInstance, deps: AssistantRouteDeps): void {
  const { prisma, guard, llm } = deps

  registerNodeChat(app, deps)

  /**
   * 读节点对话。刷新页面、换机器之后，节点里的会话还在 ——
   * 它同时是下游节点的上下文来源，只存在浏览器里就不算"对话"。
   */
  app.get('/v1/nodes/:id/messages', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const node = await prisma.node.findUnique({ where: { id }, select: { canvasId: true } })
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', '节点不存在', { nodeId: id })
    await requireCanvasWrite(prisma, node.canvasId, auth.user.id)

    const messages = await prisma.nodeMessage.findMany({
      where: { nodeId: id },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, role: true, content: true, createdAt: true },
    })
    return { messages }
  })

  /**
   * 对话：模型拿工具直接操作画布。
   *
   * 不区分"提问"和"建图"两种模式 —— 模型自己会决定是调 read_node_output
   * 回答问题，还是调 create_node / create_edge 改画布。
   *
   * 失败一律上抛（没凭据 503、厂商报错 502、协议不支持 501），
   * 由界面显示真实原因；不再返回一段"看起来像 AI 说的"离线话术。
   */
  app.post('/v1/canvases/:canvasId/assistant', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { canvasId } = request.params as { canvasId: string }
    const body = parse(bodySchema, request.body)
    await requireCanvasWrite(prisma, canvasId, auth.user.id)

    const result = await runCanvasAgent(
      llm,
      { prisma, canvasId, userId: auth.user.id },
      { message: body.message, history: body.history ?? [] },
    )

    return reply.status(200).send({
      reply: result.reply,
      changes: result.changes,
      source: 'model',
      rounds: result.rounds,
    })
  })
}
