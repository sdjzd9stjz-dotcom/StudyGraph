import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { currentMastery, schedule } from '../domain/fsrs.ts'
import type { CardState, Grade } from '../domain/fsrs.ts'
import { findCanvasForUser, requireCanvasWrite } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

/**
 * M3 · 复习调度（FSRS）与「今日到期」。
 *
 * 与 `review.ts` 的区别，别搞混：
 *   · `review.ts` 是**人工复核**（ACCEPT / REJECT 一张卡能不能进知识库）
 *   · 这里是**学生自己的记忆复习**（AGAIN / HARD / GOOD / EASY 决定下次什么时候再问）
 * 两者都会写库，但语义完全不同，所以分开成两组路由。
 */

const gradeBody = z.object({
  grade: z.enum(['AGAIN', 'HARD', 'GOOD', 'EASY']),
})

const dueQuery = z.object({
  canvasId: z.string().optional(),
  /** 一次最多取多少张，避免首屏卡死 */
  limit: z.coerce.number().int().min(1).max(200).default(30),
  /** 把这张画布上还没复习过的新卡也带上 */
  includeNew: z.coerce.boolean().default(true),
})

export interface ReviewRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
}

export function registerFsrsReviewRoutes(app: FastifyInstance, deps: ReviewRouteDeps): void {
  const { prisma, guard } = deps

  /**
   * 给一张概念卡打分，按 FSRS 排下一次。
   *
   * 并发保护用 compare-and-set 思路：先读当前状态，写回时用 `updateMany` 带条件，
   * 数量为 0 说明期间有人改过 → 409。两个标签页同时点"记得"不能算出两个不同的下次时间。
   */
  app.post('/v1/concepts/:id/grade', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const body = parse(gradeBody, request.body)

    const concept = await prisma.concept.findUnique({
      where: { id },
      select: { id: true, canvasId: true, mastery: true, dueAt: true, lastReviewedAt: true, fsrsState: true },
    })
    if (!concept) throw new AppError(404, 'CONCEPT_NOT_FOUND', '概念卡不存在')

    await requireCanvasWrite(prisma, concept.canvasId, auth.user.id)

    const stored = (concept.fsrsState ?? {}) as {
      stability?: number
      difficulty?: number
      state?: CardState
    }

    const now = new Date()
    const result = schedule({
      state: concept.lastReviewedAt
        ? {
            stability: stored.stability ?? 0,
            difficulty: stored.difficulty ?? 5,
            state: stored.state ?? 'NEW',
            lastReviewedAt: concept.lastReviewedAt,
          }
        : null,
      grade: body.grade as Grade,
      now,
    })

    // 条件写：只有"我读到的那一版"还是最新时才落库
    const updated = await prisma.concept.updateMany({
      where: { id, lastReviewedAt: concept.lastReviewedAt },
      data: {
        mastery: result.mastery,
        dueAt: result.dueAt,
        lastReviewedAt: now,
        reps: { increment: 1 },
        ...(body.grade === 'AGAIN' ? { lapses: { increment: 1 } } : {}),
        fsrsState: {
          stability: result.stability,
          difficulty: result.difficulty,
          state: result.state,
        },
      },
    })
    if (updated.count === 0) {
      throw new AppError(409, 'REVIEW_CONFLICT', '这张卡刚被别处更新过，请刷新后再评')
    }

    await prisma.reviewLog.create({
      data: {
        conceptId: id,
        userId: auth.user.id,
        grade: body.grade as 'AGAIN' | 'HARD' | 'GOOD' | 'EASY',
        stateBefore: (stored.state ?? 'NEW') as 'NEW' | 'LEARNING' | 'REVIEW' | 'RELEARNING',
        stabilityBefore: stored.stability ?? null,
        difficultyBefore: stored.difficulty ?? null,
        elapsedDays: result.elapsedDays,
        stateAfter: result.state as 'NEW' | 'LEARNING' | 'REVIEW' | 'RELEARNING',
        stabilityAfter: result.stability,
        difficultyAfter: result.difficulty,
        scheduledDays: result.scheduledDays,
        dueAt: result.dueAt,
      },
    })

    return reply.status(200).send({
      conceptId: id,
      grade: body.grade,
      state: result.state,
      stability: result.stability,
      difficulty: result.difficulty,
      scheduledDays: result.scheduledDays,
      dueAt: result.dueAt,
      mastery: result.mastery,
    })
  })

  /**
   * 今日到期（含新卡）。
   *
   * 「到期」= `dueAt <= now`。新卡（`lastReviewedAt` 为 null）默认也带上 ——
   * 否则学生建完画布打开复习页是空的，会以为坏了。
   */
  app.get('/v1/reviews/due', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const query = parse(dueQuery, request.query)
    const now = new Date()

    // 只取自己有权限的画布
    if (query.canvasId) {
      await findCanvasForUser(prisma, query.canvasId, auth.user.id)
    }

    const visibleCanvasIds = await prisma.canvas
      .findMany({
        where: {
          OR: [{ ownerId: auth.user.id }, { members: { some: { userId: auth.user.id } } }],
          ...(query.canvasId ? { id: query.canvasId } : {}),
        },
        select: { id: true },
      })
      .then((rows) => rows.map((row) => row.id))

    const concepts = await prisma.concept.findMany({
      where: {
        canvasId: { in: visibleCanvasIds },
        // 未验证的卡不进复习队列：还没确认的东西不该占用学生的记忆带宽
        status: { in: ['VERIFIED', 'PENDING_REVIEW'] },
        ...(query.includeNew ? { OR: [{ dueAt: { lte: now } }, { lastReviewedAt: null }] } : { dueAt: { lte: now } }),
      },
      orderBy: [{ dueAt: 'asc' }],
      take: query.limit,
      select: {
        id: true,
        name: true,
        definition: true,
        canvasId: true,
        dueAt: true,
        lastReviewedAt: true,
        reps: true,
        lapses: true,
        fsrsState: true,
        canvas: { select: { title: true } },
      },
    })

    return {
      now,
      count: concepts.length,
      items: concepts.map((concept) => {
        const stored = (concept.fsrsState ?? {}) as { stability?: number; state?: CardState }
        const mastery = concept.lastReviewedAt
          ? currentMastery(
              {
                stability: stored.stability ?? 0,
                difficulty: 5,
                state: stored.state ?? 'NEW',
                lastReviewedAt: concept.lastReviewedAt,
              },
              now,
            )
          : 0
        return {
          id: concept.id,
          name: concept.name,
          definition: concept.definition,
          canvasId: concept.canvasId,
          canvasTitle: concept.canvas.title,
          dueAt: concept.dueAt,
          lastReviewedAt: concept.lastReviewedAt,
          isNew: concept.lastReviewedAt === null,
          reps: concept.reps,
          lapses: concept.lapses,
          mastery,
        }
      }),
    }
  })

  /** 到期概览：今天还有多少、今天复习过多少。首页与复习页共用。 */
  app.get('/v1/reviews/stats', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const now = new Date()
    const startOfDay = new Date(now)
    startOfDay.setHours(0, 0, 0, 0)

    const visibleCanvasIds = await prisma.canvas
      .findMany({
        where: { OR: [{ ownerId: auth.user.id }, { members: { some: { userId: auth.user.id } } }] },
        select: { id: true },
      })
      .then((rows) => rows.map((row) => row.id))

    const [dueCount, newCount, reviewedToday] = await Promise.all([
      prisma.concept.count({
        where: { canvasId: { in: visibleCanvasIds }, status: { in: ['VERIFIED', 'PENDING_REVIEW'] }, lastReviewedAt: { not: null }, dueAt: { lte: now } },
      }),
      prisma.concept.count({
        where: { canvasId: { in: visibleCanvasIds }, status: { in: ['VERIFIED', 'PENDING_REVIEW'] }, lastReviewedAt: null },
      }),
      prisma.reviewLog.count({ where: { userId: auth.user.id, createdAt: { gte: startOfDay } } }),
    ])

    return { dueCount, newCount, reviewedToday }
  })
}
