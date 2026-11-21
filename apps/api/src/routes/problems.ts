import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { requireCanvasWrite } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

/**
 * 题库与组卷（M6）。
 *
 * 与 `paper` 执行器的分工：
 *   · 执行器负责"按规格自动挑题"，无人值守
 *   · 这里的接口负责"人工组卷"与"题库浏览"，学生自己挑
 * 两者写入同一张 `Paper` 表，组卷逻辑不重复实现。
 */

const listQuery = z.object({
  canvasId: z.string().min(1),
  type: z.string().optional(),
  status: z.string().optional(),
  difficulty: z.coerce.number().int().min(1).max(5).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const assembleBody = z.object({
  title: z.string().trim().min(1).max(120).default('手工组卷'),
  problemIds: z.array(z.string().min(1)).min(1).max(100),
  durationMin: z.number().int().min(5).max(600).default(60),
  pointsPerProblem: z.number().min(0.5).max(50).default(1),
})

export interface ProblemRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
}

export function registerProblemRoutes(app: FastifyInstance, deps: ProblemRouteDeps): void {
  const { prisma, guard } = deps

  /** 题库列表 */
  app.get('/v1/problems', { preHandler: guard('PROBLEM_READ') }, async (request) => {
    const auth = getAuth(request)
    const query = parse(listQuery, request.query)
    await requireCanvasWrite(prisma, query.canvasId, auth.user.id)

    const problems = await prisma.problem.findMany({
      where: {
        canvasId: query.canvasId,
        ...(query.type ? { type: query.type as never } : {}),
        ...(query.status ? { status: query.status as never } : {}),
        ...(query.difficulty ? { difficulty: query.difficulty } : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: query.limit,
      select: {
        id: true,
        type: true,
        stemMd: true,
        options: true,
        answer: true,
        judgeRule: true,
        difficulty: true,
        bloom: true,
        status: true,
        checkResult: true,
        createdAt: true,
        concepts: { select: { conceptId: true, concept: { select: { name: true } } } },
        _count: { select: { attempts: true } },
      },
    })

    return {
      problems: problems.map((problem) => ({
        id: problem.id,
        type: problem.type,
        stem: problem.stemMd,
        options: problem.options,
        answer: problem.answer,
        judgeRule: problem.judgeRule,
        difficulty: problem.difficulty,
        bloom: problem.bloom,
        status: problem.status,
        checkResult: problem.checkResult,
        attempts: problem._count.attempts,
        concepts: problem.concepts.map((link) => ({ id: link.conceptId, name: link.concept.name })),
        createdAt: problem.createdAt,
      })),
    }
  })

  app.get('/v1/problems/:id', { preHandler: guard('PROBLEM_READ') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }

    const problem = await prisma.problem.findUnique({
      where: { id },
      select: {
        id: true,
        canvasId: true,
        type: true,
        stemMd: true,
        stemMathml: true,
        options: true,
        answer: true,
        judgeRule: true,
        judgeSpec: true,
        difficulty: true,
        bloom: true,
        status: true,
        checkResult: true,
        rejectReason: true,
        concepts: { select: { conceptId: true, concept: { select: { name: true } } } },
        methods: { select: { methodId: true, method: { select: { name: true } } } },
      },
    })
    if (!problem) throw new AppError(404, 'PROBLEM_NOT_FOUND', '题目不存在')
    await requireCanvasWrite(prisma, problem.canvasId, auth.user.id)

    return {
      ...problem,
      stem: problem.stemMd,
      concepts: problem.concepts.map((link) => ({ id: link.conceptId, name: link.concept.name })),
      methods: problem.methods.map((link) => ({ id: link.methodId, name: link.method.name })),
    }
  })

  /** 手工组卷：学生自己挑题 */
  app.post('/v1/papers/assemble', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const body = parse(assembleBody, request.body)

    const problems = await prisma.problem.findMany({
      where: { id: { in: body.problemIds } },
      select: { id: true, canvasId: true, status: true },
    })
    if (problems.length !== new Set(body.problemIds).size) {
      throw new AppError(400, 'PROBLEM_NOT_FOUND', '包含不存在的题目')
    }

    // 跨画布组卷会让权限判定失效，直接拒绝
    const canvasIds = new Set(problems.map((problem) => problem.canvasId))
    if (canvasIds.size > 1) throw new AppError(400, 'PROBLEM_CROSS_CANVAS', '不能跨画布组卷')

    const canvasId = problems[0]!.canvasId
    await requireCanvasWrite(prisma, canvasId, auth.user.id)

    // 已驳回到的题不进卷子：那题自己都没过三检
    const rejected = problems.filter((problem) => problem.status === 'REJECTED')
    if (rejected.length > 0) {
      throw new AppError(400, 'PROBLEM_REJECTED', `有 ${rejected.length} 道题未通过质检，不能组卷`)
    }

    // 按传入顺序排：学生挑的顺序就是他想放的位置
    const order = new Map(body.problemIds.map((id, index) => [id, index]))

    const paper = await prisma.paper.create({
      data: {
        canvasId,
        title: body.title,
        spec: { source: 'manual', problemIds: body.problemIds } as object,
        report: {
          pickedCount: problems.length,
          problems: [
            '同题不同画布混排会让权限判定失效',
            '题库里没有的题',
            '未通过质检的题',
          ].slice(0, 0),
        } as object,
        durationMin: body.durationMin,
        status: 'DRAFT',
        createdById: auth.user.id,
        items: {
          create: problems
            .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
            .map((problem, index) => ({ problemId: problem.id, order: index + 1, points: body.pointsPerProblem })),
        },
      },
      select: { id: true, title: true, durationMin: true },
    })

    return reply.status(201).send({
      id: paper.id,
      title: paper.title,
      durationMin: paper.durationMin,
      itemCount: problems.length,
      totalPoints: problems.length * body.pointsPerProblem,
    })
  })

  /** 卷子列表 */
  app.get('/v1/papers', { preHandler: guard('PROBLEM_READ') }, async (request) => {
    const auth = getAuth(request)
    const query = parse(z.object({ canvasId: z.string() }), request.query)
    await requireCanvasWrite(prisma, query.canvasId, auth.user.id)

    const papers = await prisma.paper.findMany({
      where: { canvasId: query.canvasId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, title: true, durationMin: true, status: true, report: true, createdAt: true, _count: { select: { items: true } } },
    })
    return {
      papers: papers.map((paper) => ({
        id: paper.id,
        title: paper.title,
        durationMin: paper.durationMin,
        status: paper.status,
        report: paper.report,
        itemCount: paper._count.items,
        createdAt: paper.createdAt,
      })),
    }
  })
}
