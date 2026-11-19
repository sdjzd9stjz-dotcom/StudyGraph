import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { findCanvasForUser } from '../lib/access.ts'
import { viewNotImplemented } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

const querySchema = z.object({
  view: z.enum(['pipeline', 'knowledge', 'method']).default('pipeline'),
})

/** 未实现的视图明确 501，并说明计划节点。不许返回空数组冒充"没有数据"。 */
const VIEW_PLAN = {
  knowledge: 'M3',
  method: 'M5',
} as const

export interface GraphRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
}

export function registerGraphRoutes(app: FastifyInstance, deps: GraphRouteDeps): void {
  const { prisma, guard } = deps

  app.get('/v1/canvases/:id/graph', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const { view } = parse(querySchema, request.query)

    await findCanvasForUser(prisma, id, auth.user.id)

    if (view !== 'pipeline') {
      throw viewNotImplemented(view, VIEW_PLAN[view])
    }

    const [nodes, edges] = await Promise.all([
      prisma.node.findMany({
        where: { canvasId: id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          type: true,
          title: true,
          status: true,
          posX: true,
          posY: true,
          staleAt: true,
          staleReason: true,
        },
      }),
      prisma.edge.findMany({
        where: { canvasId: id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, fromNodeId: true, toNodeId: true, kind: true, fromPort: true, toPort: true },
      }),
    ])

    return { view, canvasId: id, nodes, edges }
  })
}
