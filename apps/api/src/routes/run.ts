import type { FastifyInstance } from 'fastify'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { requireCanvasWrite } from '../lib/access.ts'
import { nodeNotFound } from '../lib/errors.ts'
import { getExecutor } from '../nodes/registry.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

export interface RunRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
}

/**
 * `POST /v1/nodes/:id/run`（SG-SUP-004 §3.9）。
 *
 * 两步必须分开：
 *   - `?dryRun=true` → 只返回估算（不消耗 token、不入队、不写 Run）
 *   - 否则 → 入队，返回 runId
 *
 * M2 阶段还没有任何 executor，所以这条路径对 17 种类型**全部返回 501**。
 * 这不是占位，而是"未实现就明确失败"的契约：静默返回空对象是最难查的 bug。
 */
export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): void {
  const { prisma, guard } = deps

  app.post('/v1/nodes/:id/run', { preHandler: guard('RUN_EXECUTE') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const query = request.query as { dryRun?: string }
    const dryRun = query.dryRun === 'true' || query.dryRun === '1'

    const node = await prisma.node.findUnique({ where: { id }, select: { id: true, type: true, canvasId: true } })
    if (!node) throw nodeNotFound(id)

    await requireCanvasWrite(prisma, node.canvasId, auth.user.id)

    // 没有 executor → 501（带计划里程碑）。dryRun 与正式执行都走这里。
    const executor = getExecutor(node.type)

    // 以下只在 executor 存在后才可能到达（M2 尚未实现任何执行器）
    return {
      executor: executor.type,
      dryRun,
      message: 'executor 已注册，执行链路随 M2 后续批次接入',
    }
  })
}
