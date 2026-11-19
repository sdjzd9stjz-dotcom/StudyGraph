import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { NODE_TYPES, isNodeType } from '../../../../packages/contracts/src/index.ts'
import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { collectDownstream } from '../domain/graph/dag.ts'
import type { EdgeLike } from '../domain/graph/dag.ts'
import { requireCanvasWrite } from '../lib/access.ts'
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
}
