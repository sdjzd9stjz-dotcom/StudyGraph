import type { FastifyInstance } from 'fastify'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { requireCanvasWrite } from '../lib/access.ts'
import { nodeNotFound } from '../lib/errors.ts'
import type { LLMGateway } from '../llm/types.ts'
import { executeNode } from '../nodes/execute.ts'
import type { ObjectStore } from '../storage/object-store.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

export interface RunRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
  readonly objectStore: ObjectStore
  readonly llm: LLMGateway
}

/**
 * `POST /v1/nodes/:id/run`（SG-SUP-004 §3.9）。
 *
 * - `?dryRun=true` → 只算指纹与是否命中缓存，不写库、不执行
 * - 否则 → 同步执行（M2 版；队列化在 M2 后续接 BullMQ，行为契约不变）
 *
 * 未实现的节点由 registry 抛 501，这里原样上抛。
 */
export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): void {
  const { prisma, guard, objectStore, llm } = deps

  app.post('/v1/nodes/:id/run', { preHandler: guard('RUN_EXECUTE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const query = request.query as { dryRun?: string }
    const dryRun = query.dryRun === 'true' || query.dryRun === '1'

    const node = await prisma.node.findUnique({ where: { id }, select: { canvasId: true } })
    if (!node) throw nodeNotFound(id)

    await requireCanvasWrite(prisma, node.canvasId, auth.user.id)

    const outcome = await executeNode({ prisma, objectStore, llm, user: auth.user }, id, { dryRun })

    return reply.status(200).send(outcome)
  })
}
