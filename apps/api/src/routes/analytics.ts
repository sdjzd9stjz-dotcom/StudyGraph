import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

/**
 * 错题看板（M5）。
 *
 * 规格 `GET /v1/analytics/error-tags?range=30d` → 错因分布。
 *
 * 设计取舍：错因来自 `Attempt.errorTags`（JSON 数组），不是单独的错误表。
 * 这样一次作答可以带多个错因（"概念没懂" + "算错"），而统计时按 code 展开。
 * 代价是没法在 SQL 里 GROUP BY，所以这里把范围内的作答取出来在内存里聚合 ——
 * 单个学生 30 天的作答量在几百量级，这不是瓶颈。
 */

const querySchema = z.object({
  /** 形如 7d / 30d / 90d；也接受纯数字（按天） */
  range: z.string().default('30d'),
  canvasId: z.string().optional(),
})

function parseRange(raw: string): number {
  const match = /^(\d{1,3})d?$/.exec(raw.trim())
  if (!match) return 30
  const days = Number(match[1])
  return Math.min(365, Math.max(1, days))
}

export interface AnalyticsRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
}

export function registerAnalyticsRoutes(app: FastifyInstance, deps: AnalyticsRouteDeps): void {
  const { prisma, guard } = deps

  app.get('/v1/analytics/error-tags', { preHandler: guard('PROBLEM_READ') }, async (request) => {
    const auth = getAuth(request)
    const query = parse(querySchema, request.query)
    const days = parseRange(query.range)
    const since = new Date(Date.now() - days * 86_400_000)

    const attempts = await prisma.attempt.findMany({
      where: {
        userId: auth.user.id,
        createdAt: { gte: since },
        ...(query.canvasId ? { problem: { canvasId: query.canvasId } } : {}),
      },
      select: { id: true, isCorrect: true, errorTags: true, problemId: true, createdAt: true, timeSpentSec: true },
      orderBy: { createdAt: 'desc' },
    })

    const byCode = new Map<string, number>()
    let taggedAttempts = 0
    let wrongAttempts = 0
    let untaggedWrong = 0

    for (const attempt of attempts) {
      const tags = Array.isArray(attempt.errorTags) ? (attempt.errorTags as Array<{ code?: unknown }>) : []
      const codes = tags.map((tag) => (typeof tag?.code === 'string' ? tag.code : null)).filter((code): code is string => Boolean(code))
      if (codes.length > 0) taggedAttempts += 1
      if (attempt.isCorrect === false) {
        wrongAttempts += 1
        // 答错但没打任何错因：看板要能提示"这些还没被分析过"
        if (codes.length === 0) untaggedWrong += 1
      }
      for (const code of codes) byCode.set(code, (byCode.get(code) ?? 0) + 1)
    }

    // 把 code 翻成中文标签与类别；库里没有的 code 也要显示出来，不能悄悄丢掉
    const known = await prisma.errorTag.findMany({
      where: { code: { in: [...byCode.keys()] } },
      select: { code: true, label: true, category: true },
    })
    const meta = new Map(known.map((tag) => [tag.code, tag]))

    const distribution = [...byCode.entries()]
      .map(([code, count]) => ({
        code,
        count,
        label: meta.get(code)?.label ?? code,
        category: meta.get(code)?.category ?? 'UNKNOWN',
      }))
      .sort((a, b) => b.count - a.count)

    const byCategory = new Map<string, number>()
    for (const item of distribution) {
      byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + item.count)
    }

    return {
      range: `${days}d`,
      since,
      attempts: attempts.length,
      wrongAttempts,
      taggedAttempts,
      distribution,
      byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
      // 没打过错因的错题：看板要能提示"这些还没人分析过"
      untaggedWrong: attempts.filter((attempt) => attempt.isCorrect === false && !Array.isArray(attempt.errorTags) === false && (attempt.errorTags as unknown[]).length === 0).length,
    }
  })

  /** 错因词典：界面下拉框用 */
  app.get('/v1/analytics/error-tags/catalog', { preHandler: guard('PROBLEM_READ') }, async () => {
    const tags = await prisma.errorTag.findMany({ orderBy: [{ category: 'asc' }, { code: 'asc' }], select: { code: true, label: true, category: true, description: true } })
    return { tags }
  })
}
