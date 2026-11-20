import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { requireCanvasWrite } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

const bodySchema = z.object({
  decision: z.enum(['ACCEPT', 'REJECT']),
  /** 兼容指令里的字段；服务端以鉴权得到的用户为准 */
  reviewerUserId: z.string().optional(),
  note: z.string().max(500).optional(),
})

export interface ReviewRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
}

/**
 * 人工复核入口（SG-SUP-010 §2.5，SG-SUP-011 §4.2/§4.3 修正）。
 *
 * 两个并发裁决不能都成功：状态检查做成**写入条件**（compare-and-set），
 * `updateMany` 返回 `count: 0` 就是竞争失败 → 409。
 * 不要"先读、再判、后写"——那中间有窗口。
 */
export function registerReviewRoutes(app: FastifyInstance, deps: ReviewRouteDeps): void {
  const { prisma, guard } = deps

  const handle = async (kind: 'concept' | 'method', request: never, _reply: never) => {
    const auth = getAuth(request)
    const { id } = (request as unknown as { params: { id: string } }).params
    const body = bodySchema.parse((request as unknown as { body: unknown }).body ?? {})

    if (body.reviewerUserId && body.reviewerUserId !== auth.user.id) {
      throw new AppError(403, 'INSUFFICIENT_SCOPE', '不能代替他人复核', { reviewerUserId: body.reviewerUserId })
    }

    const entity =
      kind === 'concept'
        ? await prisma.concept.findUnique({ where: { id }, select: { canvasId: true, status: true } })
        : await prisma.method.findUnique({ where: { id }, select: { canvasId: true, status: true } })
    if (!entity) throw new AppError(404, 'NODE_NOT_FOUND', '对象不存在', { id })

    // 复用 M1 的画布权限：非编辑者 → 403
    await requireCanvasWrite(prisma, entity.canvasId, auth.user.id)

    if (entity.status !== 'PENDING_REVIEW') {
      throw new AppError(409, 'CONFLICT', `只有 PENDING_REVIEW 可以复核，当前是 ${entity.status}`, {
        id,
        status: entity.status,
      })
    }

    const reviewedAt = new Date()
    const reviewedBy = auth.user.id

    // CAS：把 "status = PENDING_REVIEW" 作为写入条件，两个并发请求只有一个能改到行
    const result =
      kind === 'concept'
        ? await prisma.concept.updateMany({
            where: { id, status: 'PENDING_REVIEW' },
            data: {
              status: body.decision === 'ACCEPT' ? ('VERIFIED' as const) : ('UNVERIFIED' as const),
              reviewedAt,
              reviewedBy,
            },
          })
        : await prisma.method.updateMany({
            where: { id, status: 'PENDING_REVIEW' },
            data: {
              status: body.decision === 'ACCEPT' ? ('VERIFIED' as const) : ('UNVERIFIED' as const),
              reviewedAt,
              reviewedBy,
            },
          })

    if (result.count === 0) {
      throw new AppError(409, 'CONFLICT', '该条目已被他人复核', { id })
    }

    const updated =
      kind === 'concept'
        ? await prisma.concept.findUnique({ where: { id }, select: { id: true, status: true, reviewedAt: true, reviewedBy: true } })
        : await prisma.method.findUnique({ where: { id }, select: { id: true, status: true, reviewedAt: true, reviewedBy: true } })

    return { ...updated, note: body.note ?? null }
  }

  app.post('/v1/concepts/:id/review', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const result = await handle('concept', request as never, reply as never)
    return reply.status(200).send(result)
  })

  app.post('/v1/methods/:id/review', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const result = await handle('method', request as never, reply as never)
    return reply.status(200).send(result)
  })
}
