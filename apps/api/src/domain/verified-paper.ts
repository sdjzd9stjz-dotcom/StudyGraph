import { Prisma } from '@prisma/client'
import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { AppError } from '../lib/errors.ts'

export function verifiedPaperPool(prisma: PrismaClient, canvasId: string) {
  return prisma.problem.findMany({
    where: { canvasId, status: 'VERIFIED' },
    orderBy: [{ difficulty: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, type: true, difficulty: true, concepts: { orderBy: { conceptId: 'asc' }, select: { conceptId: true } } },
  })
}

export async function createVerifiedPaper(prisma: PrismaClient, data: Omit<Prisma.PaperUncheckedCreateInput, 'items'>, ids: string[], points: number) {
  return prisma.$transaction(async tx => {
    if (ids.length) {
      // 题目可能在勾选或自动挑题之后被降级。共享行锁把最后一次检查与试卷写入放在同一个提交里。
      const rows = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM "Problem"
        WHERE "canvasId" = ${data.canvasId} AND id IN (${Prisma.join(ids)})
        ORDER BY id FOR SHARE
      `
      if (rows.length !== ids.length) throw new AppError(400, 'PROBLEM_NOT_FOUND', '所选题目已变更，请刷新题库后重新组卷')
      if (rows.some(p => p.status === 'REJECTED')) throw new AppError(400, 'PROBLEM_REJECTED', '所选题目含质检未通过的题，本次未组卷')
      if (rows.some(p => p.status !== 'VERIFIED')) throw new AppError(400, 'PROBLEM_NOT_VERIFIED', '所选题目含待质检的题，只有 VERIFIED 题目可以组卷')
    }
    return tx.paper.create({
      data: { ...data, items: { create: ids.map((problemId, i) => ({ problemId, order: i + 1, points })) } },
      select: { id: true, title: true, durationMin: true },
    })
  })
}
