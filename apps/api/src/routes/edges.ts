import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { EDGE_KINDS, defaultPortName, validateConnection } from '../../../../packages/contracts/src/index.ts'
import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { requireCanvasWrite } from '../lib/access.ts'
import {
  AppError,
  canvasIdInBody,
  edgeDuplicate,
  edgeSelfLoop,
  nodeNotInCanvas,
} from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

const createEdgeBody = z
  .object({
    fromNodeId: z.string().min(1),
    toNodeId: z.string().min(1),
    kind: z.enum(EDGE_KINDS).optional(),
    fromPort: z.string().min(1).optional(),
    toPort: z.string().min(1).optional(),
  })
  .passthrough()

export interface EdgeRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
}

export function registerEdgeRoutes(app: FastifyInstance, deps: EdgeRouteDeps): void {
  const { prisma, guard } = deps

  app.post('/v1/canvases/:canvasId/edges', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { canvasId } = request.params as { canvasId: string }

    // canvasId 只能从路径取：body 里出现就 400，防止客户端指定别人的画布
    const rawBody = request.body
    if (rawBody && typeof rawBody === 'object' && 'canvasId' in rawBody) {
      throw canvasIdInBody()
    }

    const body = parse(createEdgeBody, rawBody)

    // 1. 画布存在 + 有写权限
    await requireCanvasWrite(prisma, canvasId, auth.user.id)

    // 2. 两端节点存在且属于该画布（一条查询判定，避免两次往返还判错）
    const nodes = await prisma.node.findMany({
      where: { id: { in: [body.fromNodeId, body.toNodeId] }, canvasId },
      select: { id: true, type: true },
    })
    const fromNode = nodes.find((node) => node.id === body.fromNodeId)
    const toNode = nodes.find((node) => node.id === body.toNodeId)
    if (!fromNode || !toNode) throw nodeNotInCanvas(canvasId, [body.fromNodeId, body.toNodeId])

    // 3. 自环
    if (body.fromNodeId === body.toNodeId) throw edgeSelfLoop(body.fromNodeId)

    // 4–6. 端口存在 / 非入口端口 / 类型相同 —— 全部交给 contracts，不在这里重写一份
    const fromPort = body.fromPort ?? defaultPortName(fromNode.type, 'output')
    const toPort = body.toPort ?? defaultPortName(toNode.type, 'input')

    const check = validateConnection({
      fromType: fromNode.type,
      fromPort: fromPort ?? '',
      toType: toNode.type,
      toPort: toPort ?? '',
    })

    if (!check.ok) {
      // 直接复用 contracts 的 errorCode，不在后端另起一套码表
      throw new AppError(400, check.code, check.message, check.details)
    }

    // 7. 唯一性交给数据库：直接 insert 并捕获 P2002（先查后插在并发下必漏）
    try {
      const edge = await prisma.edge.create({
        data: {
          canvasId,
          fromNodeId: body.fromNodeId,
          toNodeId: body.toNodeId,
          kind: body.kind ?? 'DERIVED_FROM',
          fromPort: fromPort ?? 'out',
          toPort: toPort ?? 'in',
        },
        select: {
          id: true,
          canvasId: true,
          fromNodeId: true,
          toNodeId: true,
          kind: true,
          fromPort: true,
          toPort: true,
        },
      })
      return reply.status(201).send(edge)
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
        throw edgeDuplicate({
          canvasId,
          fromNodeId: body.fromNodeId,
          toNodeId: body.toNodeId,
          kind: body.kind ?? 'DERIVED_FROM',
        })
      }
      throw error
    }
  })
}
