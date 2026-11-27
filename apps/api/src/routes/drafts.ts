import { forOperation } from '../llm/reasoning.ts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { NODE_TYPES, isNodeType, validateConnection, defaultPortName } from '../../../../packages/contracts/src/index.ts'
import type { NodeType } from '../../../../packages/contracts/src/index.ts'
import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import type { LLMGateway } from '../llm/types.ts'
import { requireCanvasWrite } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

/**
 * G1 · 对话式编排（M4.5）。
 *
 * 三条约束（规格原文）：
 *   1. 草案**不落画布、不执行、不消耗任务 token**（生成草案那次模型调用除外，且计入 UsageRecord）
 *   2. **必须显式确认才落画布**，落地后节点是 DRAFT，仍需逐节点执行
 *   3. 草案里每个节点给出端口类型与上游依赖，**落画布走与手工创建相同的校验**，不做特权通道
 *
 * 明确不做：agent 连续自动执行多步（TapNow 式"一路做到底"）——
 * 那与「执行必须显式触发」直接冲突。
 */

const createBody = z.object({ request: z.string().trim().min(2).max(2000) })

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '临时标识，边用它引用' },
          type: { type: 'string', description: `节点类型，必须是：${NODE_TYPES.join(' / ')}` },
          title: { type: 'string' },
          reason: { type: 'string', description: '为什么需要这个节点' },
        },
        required: ['key', 'type', 'title'],
        additionalProperties: false,
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          fromPort: { type: 'string' },
          toPort: { type: 'string' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
    },
  },
  required: ['nodes', 'edges'],
  additionalProperties: false,
} as const

const SYSTEM = `你是学习工作流的编排助手。根据学生的需求，给出一张节点图草案。

可用节点类型：${NODE_TYPES.join(' / ')}
常见的合理流程是：SOURCE（课件）→ CHUNK（切片）→ EXTRACT（抽取概念）→ CARD（建卡）→ PREREQ（先修关系）

要求：
- 只给出确实需要的节点，不要为了"看起来完整"而堆节点
- 边的 from/to 用节点的 key 引用
- 不要给出课件内容，SOURCE 节点的文件由学生自己上传
- 每个节点写一句 reason，说明它在流程里的作用`

interface ProposalNode {
  readonly key: string
  readonly type: string
  readonly title: string
  readonly reason?: string
}
interface ProposalEdge {
  readonly from: string
  readonly to: string
  readonly fromPort?: string
  readonly toPort?: string
}

export interface DraftRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
  readonly llm: LLMGateway
}

export function registerDraftRoutes(app: FastifyInstance, deps: DraftRouteDeps): void {
  const { prisma, guard, llm } = deps

  /** 生成草案：只写 GraphDraft，不碰 Canvas / Node。 */
  app.post('/v1/canvases/:id/drafts', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id: canvasId } = request.params as { id: string }
    const body = parse(createBody, request.body)
    await requireCanvasWrite(prisma, canvasId, auth.user.id)

    const user = { ...auth.user, canvasId }
    const draftModel = await forOperation(llm, 'method', user, 'draft')
    const result = await draftModel.complete({
      taskType: 'method',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: body.request },
      ],
      jsonSchema: PROPOSAL_SCHEMA,
      user,
    })

    const raw = result.data as { nodes?: ProposalNode[]; edges?: ProposalEdge[] }
    const nodes = (raw.nodes ?? []).filter((node) => isNodeType(node.type))
    const droppedTypes = (raw.nodes ?? []).filter((node) => !isNodeType(node.type)).map((node) => node.type)

    const known = new Set(nodes.map((node) => node.key))
    const edges = (raw.edges ?? []).filter((edge) => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to)

    // 生成草案这一次调用要计费：它是真的花了 token，不能装作免费
    await prisma.usageRecord.create({
      data: {
        userId: auth.user.id,
        canvasId,
        surface: 'NODE_RUN',
        provider: result.provider,
        model: result.modelVersion,
        tokensIn: result.usage.tokensIn,
        tokensOut: result.usage.tokensOut,
        cachedTokens: result.usage.cachedTokens,
        cacheUsageComplete: result.usage.cacheUsageComplete !== false,
      },
    })

    const draft = await prisma.graphDraft.create({
      data: {
        canvasId,
        ownerId: auth.user.id,
        request: body.request,
        // Prisma 的 Json 入参要求可索引对象；这里的形状是运行时确定的
        proposal: { nodes, edges, droppedTypes } as unknown as object,
        status: 'PROPOSED',
      },
      select: { id: true, status: true, createdAt: true },
    })

    return reply.status(201).send({
      ...draft,
      proposal: { nodes, edges, droppedTypes },
      usage: result.usage,
    })
  })

  app.get('/v1/canvases/:id/drafts', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const { id: canvasId } = request.params as { id: string }
    await requireCanvasWrite(prisma, canvasId, auth.user.id)

    const drafts = await prisma.graphDraft.findMany({
      where: { canvasId, ownerId: auth.user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, request: true, proposal: true, status: true, createdAt: true },
    })
    return { drafts }
  })

  /**
   * 确认草案 → 落画布。
   *
   * 落盘时**重新做一遍**与手工创建相同的校验（节点类型、端口类型匹配），
   * 不做特权通道：草案是模型给的，模型会犯错。
   * 落地后节点是 DRAFT，**不会**自动执行。
   */
  app.post('/v1/drafts/:id/accept', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }

    const draft = await prisma.graphDraft.findFirst({ where: { id, ownerId: auth.user.id } })
    if (!draft) throw new AppError(404, 'DRAFT_NOT_FOUND', '草案不存在')
    if (draft.status !== 'PROPOSED') {
      throw new AppError(409, 'DRAFT_NOT_PROPOSED', `草案状态是 ${draft.status}，不能再确认`)
    }
    await requireCanvasWrite(prisma, draft.canvasId, auth.user.id)

    const proposal = draft.proposal as { nodes?: ProposalNode[]; edges?: ProposalEdge[] }
    const nodes = proposal.nodes ?? []
    const edges = proposal.edges ?? []

    // 先离线校验整张图，任何一条不合法就整体拒绝 —— 落一半的图比不落更糟
    const invalid: Array<{ what: string; detail: string }> = []
    for (const node of nodes) {
      if (!isNodeType(node.type)) invalid.push({ what: 'node', detail: `未知类型 ${node.type}` })
    }
    // 类型已逐个校验过；这里收窄成 NodeType，后续端口校验与建节点共用同一份
    const typedNodes = nodes.map((node) => ({ ...node, type: node.type as NodeType }))
    const byKey = new Map(typedNodes.map((node) => [node.key, node]))
    for (const edge of edges) {
      const from = byKey.get(edge.from)
      const to = byKey.get(edge.to)
      if (!from || !to) {
        invalid.push({ what: 'edge', detail: `${edge.from} → ${edge.to} 端点不存在` })
        continue
      }
      const check = validateConnection({
        fromType: from.type,
        fromPort: edge.fromPort ?? defaultPortName(from.type, 'output') ?? '',
        toType: to.type,
        toPort: edge.toPort ?? defaultPortName(to.type, 'input') ?? '',
      })
      if (!check.ok) invalid.push({ what: 'edge', detail: `${edge.from} → ${edge.to}：${check.message}` })
    }
    if (invalid.length > 0) {
      throw new AppError(400, 'DRAFT_INVALID', '草案含不合法的节点或连线，未落画布', { invalid })
    }

    const created = await prisma.$transaction(async (tx) => {
      const idMap = new Map<string, string>()
      let posX = 0
      for (const node of typedNodes) {
        const createdNode = await tx.node.create({
          data: {
            canvasId: draft.canvasId,
            type: node.type as NodeType,
            title: node.title,
            params: {},
            // 落地后是 DRAFT：没跑过、没产物、没指纹，必须由学生逐个显式执行
            status: 'DRAFT',
            posX,
            posY: 0,
          },
          select: { id: true },
        })
        idMap.set(node.key, createdNode.id)
        posX += 240
      }

      for (const edge of edges) {
        const fromId = idMap.get(edge.from)
        const toId = idMap.get(edge.to)
        if (!fromId || !toId) continue
        await tx.edge.create({
          data: {
            canvasId: draft.canvasId,
            fromNodeId: fromId,
            toNodeId: toId,
            kind: 'DERIVED_FROM',
            fromPort: edge.fromPort ?? defaultPortName(byKey.get(edge.from)!.type, 'output') ?? 'out',
            toPort: edge.toPort ?? defaultPortName(byKey.get(edge.to)!.type, 'input') ?? 'in',
          },
        })
      }

      await tx.graphDraft.update({ where: { id }, data: { status: 'ACCEPTED' } })
      return { nodeCount: idMap.size, edgeCount: edges.length }
    })

    return reply.status(201).send({
      draftId: id,
      status: 'ACCEPTED',
      canvasId: draft.canvasId,
      ...created,
      // 明确告诉调用方：这里没有执行任何东西
      executed: false,
    })
  })

  app.post('/v1/drafts/:id/discard', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const draft = await prisma.graphDraft.findFirst({ where: { id, ownerId: auth.user.id }, select: { id: true, status: true } })
    if (!draft) throw new AppError(404, 'DRAFT_NOT_FOUND', '草案不存在')
    if (draft.status !== 'PROPOSED') throw new AppError(409, 'DRAFT_NOT_PROPOSED', `草案状态是 ${draft.status}`)

    await prisma.graphDraft.update({ where: { id }, data: { status: 'DISCARDED' } })
    return reply.status(200).send({ draftId: id, status: 'DISCARDED' })
  })
}
