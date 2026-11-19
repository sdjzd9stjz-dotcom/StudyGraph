import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { requireCanvasWrite } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

const bodySchema = z.object({
  decision: z.enum(['ACCEPT', 'REJECT']),
  /** 兼容指令里的字段；服务端以鉴权得到的用户为准，不接受伪造他人 */
  reviewerUserId: z.string().optional(),
  note: z.string().max(500).optional(),
})

export interface ReviewRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
}

/**
 * 人工复核入口（SG-SUP-010 §2.5）。
 *
 * `PENDING_REVIEW` 如果没有出口，就是一个永远不进不退的死状态——
 * 比少几张卡更难解释。M2 不做 UI，但接口必须有。
 *
 * 约束：
 * - 只有**该画布的编辑者**能复核（复用 M1 的 CanvasRole）
 * - `reviewedBy` 用鉴权用户，不采信 body 里的 reviewerUserId
 * - **不提供批量接口**：批量通过等于把人工复核变成一键放行
 */
export function registerReviewRoutes(app: FastifyInstance, deps: ReviewRouteDeps): void {
  const { prisma, guard } = deps

  const review = (kind: 'concept' | 'method') =>
    async (request: { params: unknown; body: unknown }) => {
      const auth = getAuth(request as never)
      const { id } = request.params as { id: string }
      const body = bodySchema.parse(request.body ?? {})

      if (body.reviewerUserId && body.reviewerUserId !== auth.user.id) {
        throw new AppError(403, 'INSUFFICIENT_SCOPE', '不能代替他人复核', { reviewerUserId: body.reviewerUserId })
      }

      const entity =
        kind === 'concept'
          ? await prisma.concept.findUnique({ where: { id }, select: { id: true, canvasId: true, status: true } })
          : await prisma.method.findUnique({ where: { id }, select: { id: true, canvasId: true, status: true } })
      if (!entity) throw new AppError(404, kind === 'concept' ? 'NODE_NOT_FOUND' : 'NODE_NOT_FOUND', '对象不存在', { id })

      // 复用 M1 的画布权限：非编辑者 → 403
      await requireCanvasWrite(prisma, entity.canvasId, auth.user.id)

      if (entity.status !== 'PENDING_REVIEW') {
        throw new AppError(409, 'VALIDATION_FAILED', `只有 PENDING_REVIEW 可以复核，当前是 ${entity.status}`, {
          id,
          status: entity.status,
        })
      }

      const nextStatus = body.decision === 'ACCEPT' ? 'VERIFIED' : 'UNVERIFIED'
      const data = { status: nextStatus, reviewedAt: new Date(), reviewedBy: auth.user.id }

      const updated =
        kind === 'concept'
          ? await prisma.concept.update({ where: { id }, data, select: { id: true, status: true, reviewedAt: true, reviewedBy: true } })
          : await prisma.method.update({ where: { id }, data, select: { id: true, status: true, reviewedAt: true, reviewedBy: true } })

      return { id: updated.id, status: updated.status, reviewedAt: updated.reviewedAt, reviewedBy: updated.reviewedBy, note: body.note ?? null }
    }

  app.post('/v1/concepts/:id/review', { preHandler: guard('CANVAS_WRITE') }, review('concept') as never)
  app.post('/v1/methods/:id/review', { preHandler: guard('CANVAS_WRITE') }, review('method') as never)
}
