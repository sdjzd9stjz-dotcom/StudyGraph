import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { NODE_TYPES, isNodeType } from '../../../../packages/contracts/src/index.ts'
import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { collectDownstream } from '../domain/graph/dag.ts'
import { inspectSplit, splitCardsForConcepts } from '../domain/split-cards.ts'
import type { EdgeLike } from '../domain/graph/dag.ts'
import { findCanvasForUser, requireCanvasWrite } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import { nodeNotFound, nodeParamsInvalid, nodeTypeInvalid } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

const paramsSchema = z.record(z.string(), z.unknown())

const createNodeBody = z.object({
  type: z.string(),
  title: z.string().trim().max(200).optional(),
  params: z.unknown().optional(),
  posX: z.number().finite().optional(),
  posY: z.number().finite().optional(),
})

const patchNodeBody = z
  .object({
    title: z.string().trim().max(200).nullable().optional(),
    params: z.unknown().optional(),
    posX: z.number().finite().optional(),
    posY: z.number().finite().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个字段' })

const gateDecisionBody = z
  .object({
    approved: z.boolean(),
    note: z.string().trim().max(2000).optional(),
  })
  .refine((value) => value.approved || (value.note !== undefined && value.note.length > 0), {
    message: '拒绝时必须填写理由（note）',
  })

function validateParams(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {}
  // M1 只要求"是 JSON 对象"；每个 type 的具名 schema 随 M2 的执行器一起落地
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw nodeParamsInvalid('params 必须是 JSON 对象')
  }
  const result = paramsSchema.safeParse(raw)
  if (!result.success) throw nodeParamsInvalid(result.error.issues.map((issue) => issue.message).join('; '))
  return result.data
}

export interface NodeRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
}

export function registerNodeRoutes(app: FastifyInstance, deps: NodeRouteDeps): void {
  const { prisma, guard } = deps

  app.post('/v1/canvases/:canvasId/nodes', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { canvasId } = request.params as { canvasId: string }
    const body = parse(createNodeBody, request.body)

    await requireCanvasWrite(prisma, canvasId, auth.user.id)

    if (!isNodeType(body.type)) throw nodeTypeInvalid(body.type, NODE_TYPES)
    const params = validateParams(body.params)

    const node = await prisma.node.create({
      data: {
        canvasId,
        type: body.type,
        title: body.title ?? null,
        params: params as object,
        status: 'DRAFT', // 新节点是 DRAFT，不是 READY
        posX: body.posX ?? 0,
        posY: body.posY ?? 0,
      },
      select: { id: true, type: true, status: true, posX: true, posY: true, title: true },
    })

    return reply.status(201).send(node)
  })

  /**
   * 按概念拆分知识卡：一个概念 = 一个 CARD 节点。
   *
   * 用户 2026-11-21 要求「知识卡请按知识点分到多个节点中而非单一节点」。
   * 拆出来的节点都是 DRAFT、都带 `params.conceptName`，运行时只产出自己那一张。
   * 已经拆过的概念不会重复建（按 conceptName 判重）。
   */
  /**
   * 取讲义原文（导出 PDF 用）。
   *
   * 前端拿到的 `outputSummary` 是给人看的摘要，不是正文；
   * PDF 必须用完整 markdown，所以单独给一个只读接口。
   */
  app.get('/v1/nodes/:id/lecture', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const node = await prisma.node.findUnique({
      where: { id },
      select: { canvasId: true, type: true, title: true },
    })
    if (!node) throw nodeNotFound(id)
    await requireCanvasWrite(prisma, node.canvasId, auth.user.id)

    const artifact = await prisma.artifact.findFirst({
      where: { nodeId: id },
      orderBy: { createdAt: 'desc' },
      select: { kind: true, structured: true },
    })
    if (!artifact || artifact.kind !== 'LECTURE_DOC') {
      throw new AppError(404, 'NODE_NOT_FOUND', '这个节点还没有讲义（先运行一次导出讲义）', { nodeId: id })
    }
    const data = artifact.structured as { title?: unknown; markdown?: unknown; outline?: unknown } | null
    return {
      title: typeof data?.title === 'string' ? data.title : (node.title ?? '课程讲义'),
      markdown: typeof data?.markdown === 'string' ? data.markdown : '',
      outline: Array.isArray(data?.outline) ? data.outline : [],
    }
  })

  app.get('/v1/nodes/:id/split-cards', { preHandler: guard('CANVAS_READ') }, async request => {
    const { id } = request.params as { id: string }
    const node = await prisma.node.findUnique({ where: { id }, select: { canvasId: true } })
    if (!node) throw nodeNotFound(id)
    await findCanvasForUser(prisma, node.canvasId, getAuth(request).user.id)
    return inspectSplit(prisma, { canvasId: node.canvasId, extractNodeId: id })
  })

  app.post('/v1/nodes/:id/split-cards', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const node = await prisma.node.findUnique({ where: { id }, select: { canvasId: true } })
    if (!node) throw nodeNotFound(id)
    await requireCanvasWrite(prisma, node.canvasId, auth.user.id)

    const outcome = await splitCardsForConcepts(prisma, { canvasId: node.canvasId, extractNodeId: id })
    return reply.status(201).send(outcome)
  })

  app.patch('/v1/nodes/:id', { preHandler: guard('CANVAS_WRITE') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const body = parse(patchNodeBody, request.body)

    const existing = await prisma.node.findUnique({ where: { id }, select: { id: true, canvasId: true } })
    if (!existing) throw nodeNotFound(id)
    await requireCanvasWrite(prisma, existing.canvasId, auth.user.id)

    const data: Record<string, unknown> = {}
    if (body.title !== undefined) data.title = body.title
    if (body.params !== undefined) data.params = validateParams(body.params)
    if (body.posX !== undefined) data.posX = body.posX
    if (body.posY !== undefined) data.posY = body.posY

    const node = await prisma.node.update({
      where: { id },
      data,
      select: { id: true, type: true, title: true, status: true, posX: true, posY: true, params: true },
    })

    return node
  })

  /**
   * 只标 stale，不执行（硬约束 2）。
   * 起点 + 全部下游（沿 DERIVED_FROM）置 STALE；**不写 Run、不入队、不调模型**。
   */
  app.post('/v1/nodes/:id/mark-stale', { preHandler: guard('CANVAS_WRITE') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }

    const node = await prisma.node.findUnique({ where: { id }, select: { id: true, canvasId: true, status: true } })
    if (!node) throw nodeNotFound(id)
    await requireCanvasWrite(prisma, node.canvasId, auth.user.id)

    const edges = await prisma.edge.findMany({
      where: { canvasId: node.canvasId },
      select: { fromNodeId: true, toNodeId: true, kind: true },
    })

    const downstream = collectDownstream(edges as EdgeLike[], node.id)
    const staleNodeIds = [node.id, ...downstream]

    const stamped = new Date()
    await prisma.node.updateMany({
      where: { id: { in: staleNodeIds } },
      data: { status: 'STALE', staleAt: stamped, staleReason: `上游节点 ${node.id} 已变更` },
    })

    return {
      rootNodeId: node.id,
      staleNodeIds,
      // 明确写出来，验收时会查 Run 表行数前后不变
      runCreated: false,
    }
  })

  /**
   * 人工闸门放行 / 拒绝（GATE 节点专用）。
   *
   * 为什么单独一个接口而不是让学生去 PATCH params.approved：
   * 放行是**一次有后果的决策**，需要留下「谁、什么时候、看了什么、为什么」。
   * 直接改 params 只能改到值，改不出这些痕迹；而且任何人都能改 params，
   * 闸门的意义就被绕开了。
   *
   * 拒绝必须给理由 —— 无理由的拒绝，上游不知道要改什么。
   */
  app.post('/v1/nodes/:id/gate-decision', { preHandler: guard('CANVAS_WRITE') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const body = parse(gateDecisionBody, request.body)

    const node = await prisma.node.findUnique({
      where: { id },
      select: { id: true, canvasId: true, type: true, params: true, status: true },
    })
    if (!node) throw nodeNotFound(id)
    await requireCanvasWrite(prisma, node.canvasId, auth.user.id)

    if (node.type !== 'GATE') {
      throw new AppError(400, 'NODE_NOT_GATE', `只有 GATE 节点可以放行/拒绝，当前类型是 ${node.type}`)
    }

    const params = (node.params ?? {}) as Record<string, unknown>
    const decidedAt = new Date().toISOString()

    const nextParams = {
      ...params,
      approved: body.approved,
      note: body.note ?? null,
      // 决策留痕：谁在什么时候做了什么决定
      decidedBy: auth.user.id,
      decidedAt,
    }

    await prisma.node.update({ where: { id }, data: { params: nextParams } })

    return {
      nodeId: id,
      approved: body.approved,
      note: body.note ?? null,
      decidedAt,
      /**
       * 放行后**不自动执行下游**（硬约束 2）。
       * 下游需要学生自己点运行 —— 自动执行会让"我还没准备好"这件事做不到。
       */
      downstreamTriggered: false,
    }
  })

  /**
   * 删除节点。
   *
   * 级联删除的边界由数据库外键决定：连线、产物、运行记录、绑定都随节点一起走，
   * 但**分组不会被删** —— 组只是「这几个节点一起看」，成员没了组可能还有别的成员。
   */
  app.delete('/v1/nodes/:id', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }

    const node = await prisma.node.findUnique({ where: { id }, select: { canvasId: true } })
    if (!node) throw nodeNotFound(id)
    await requireCanvasWrite(prisma, node.canvasId, auth.user.id)

    await prisma.node.delete({ where: { id } })
    return reply.status(204).send()
  })
}
