import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { buildContextKey, refreshMethodProficiency } from '../domain/proficiency.ts'
import { requireCanvasWrite } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

/**
 * 作答与判分（M5/M6）。
 *
 * 判分是确定性的、本地完成的 —— 不调模型。理由：
 * 一道选择题对不对，靠答案比对就够了；让模型判分既慢又可能判错，
 * 而且会把「判分」变成不可复现的行为（同一份作答两次判出不同结果）。
 * 只有 RUBRIC（主观题）才需要模型，那条路径单独标 TODO 并明确返回待判状态。
 */

const submitBody = z.object({
  answer: z.unknown(),
  timeSpentSec: z.number().int().min(0).max(86_400).default(0),
  /** 学生自己用的方法（可选）：用于回写熟练度 */
  methodIds: z.array(z.string()).max(5).default([]),
})

export interface AttemptRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
}

const norm = (value: unknown): string => String(value ?? '').trim().toLowerCase()

/** 按 judgeRule 判分。返回 null 表示"需要人工/异步判"，不是错。 */
function judge(
  rule: string,
  spec: unknown,
  expected: unknown,
  submitted: unknown,
): { isCorrect: boolean | null; detail: Record<string, unknown> } {
  if (rule === 'CHOICE' || rule === 'EXACT') {
    const isCorrect = norm(expected) === norm(submitted)
    return { isCorrect, detail: { rule, expected: norm(expected), submitted: norm(submitted) } }
  }

  if (rule === 'NUMERIC_TOL') {
    const tolerance = Number((spec as { tolerance?: unknown } | null)?.tolerance ?? 0)
    const actual = Number(submitted)
    const target = Number(expected)
    if (!Number.isFinite(actual) || !Number.isFinite(target)) {
      return { isCorrect: false, detail: { rule, reason: 'NOT_A_NUMBER' } }
    }
    const isCorrect = Math.abs(actual - target) <= tolerance
    return { isCorrect, detail: { rule, target, actual, tolerance, diff: Math.abs(actual - target) } }
  }

  // RUBRIC：需要按评分步骤逐条判，这一步要模型/人工，不在这里假装完成
  return { isCorrect: null, detail: { rule: 'RUBRIC', pending: 'MANUAL_OR_ASYNC_JUDGE' } }
}

export function registerAttemptRoutes(app: FastifyInstance, deps: AttemptRouteDeps): void {
  const { prisma, guard } = deps

  app.post('/v1/problems/:id/attempts', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id: problemId } = request.params as { id: string }
    const body = parse(submitBody, request.body)

    const problem = await prisma.problem.findUnique({
      where: { id: problemId },
      select: {
        id: true,
        canvasId: true,
        type: true,
        // options 必须 select：错因靠选项自带的 errorTag 反查。
        // 少了这一行，下面 `problem.options` 永远是 undefined，
        // 错因标记静默失效 —— 作答有数据、看板永远空，最难查的那种坏法。
        options: true,
        answer: true,
        judgeRule: true,
        judgeSpec: true,
        status: true,
        concepts: { select: { conceptId: true } },
      },
    })
    if (!problem) throw new AppError(404, 'PROBLEM_NOT_FOUND', '题目不存在')
    await requireCanvasWrite(prisma, problem.canvasId, auth.user.id)

    const verdict = judge(problem.judgeRule, problem.judgeSpec, problem.answer, body.answer)

    // 错因：由选项自带的 errorTag 反查（干扰项必须诊断错因是这个项目的硬约束）
    const errorTags: Array<{ code: string; note?: string }> = []
    if (verdict.isCorrect === false && Array.isArray((problem as { options?: unknown }).options)) {
      const options = (problem as unknown as { options: Array<{ key?: unknown; errorTag?: unknown }> }).options
      const chosen = options.find((option) => norm(option.key) === norm(body.answer))
      if (typeof chosen?.errorTag === 'string') errorTags.push({ code: chosen.errorTag })
    }

    const attempt = await prisma.attempt.create({
      data: {
        problemId,
        userId: auth.user.id,
        answer: body.answer as object,
        isCorrect: verdict.isCorrect,
        errorTags: errorTags as unknown as object,
        judgeDetail: verdict.detail as object,
        timeSpentSec: body.timeSpentSec,
      },
      select: { id: true, isCorrect: true, errorTags: true, createdAt: true },
    })

    /**
     * 方法应用记录 + 熟练度回写。
     *
     * 情境指纹用「题型 + 概念组合」：与已有记录的情境不同就算迁移（isTransfer）。
     * 这是规格里「迁移成功率」的数据来源，不做这一步，proficiency 永远是 0。
     */
    const refreshed: Array<{ methodId: string; proficiency: number; isTransfer: boolean }> = []
    if (body.methodIds.length > 0) {
      const contextKey = buildContextKey(
        problem.type,
        problem.concepts.map((concept) => concept.conceptId),
      )

      for (const methodId of body.methodIds) {
        const method = await prisma.method.findFirst({ where: { id: methodId, canvasId: problem.canvasId }, select: { id: true } })
        if (!method) continue

        // 这个方法以前在别的情境下用过吗？用过 → 这次算迁移
        const seenInOtherContext = await prisma.methodApplication.findFirst({
          where: { methodId, contextKey: { not: contextKey }, userId: auth.user.id },
          select: { id: true },
        })

        await prisma.methodApplication.create({
          data: {
            methodId,
            problemId,
            attemptId: attempt.id,
            userId: auth.user.id,
            isCorrect: verdict.isCorrect === true,
            isTransfer: Boolean(seenInOtherContext),
            // 用了方法却答错 = 误用（选错方法或条件不满足仍使用）
            isMisuse: verdict.isCorrect === false,
            contextKey,
          },
        })

        const result = await refreshMethodProficiency(prisma as never, methodId)
        refreshed.push({ methodId, proficiency: result.proficiency, isTransfer: Boolean(seenInOtherContext) })
      }
    }

    return reply.status(201).send({
      attemptId: attempt.id,
      isCorrect: verdict.isCorrect,
      // null = 待判（主观题），不是错
      pending: verdict.isCorrect === null,
      errorTags,
      judgeDetail: verdict.detail,
      methodProficiency: refreshed,
    })
  })

  /** 某道题的作答历史 */
  app.get('/v1/problems/:id/attempts', { preHandler: guard('PROBLEM_READ') }, async (request) => {
    const auth = getAuth(request)
    const { id: problemId } = request.params as { id: string }

    const problem = await prisma.problem.findUnique({ where: { id: problemId }, select: { canvasId: true } })
    if (!problem) throw new AppError(404, 'PROBLEM_NOT_FOUND', '题目不存在')
    await requireCanvasWrite(prisma, problem.canvasId, auth.user.id)

    const attempts = await prisma.attempt.findMany({
      where: { problemId, userId: auth.user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, answer: true, isCorrect: true, errorTags: true, timeSpentSec: true, createdAt: true },
    })
    return { attempts }
  })
}
