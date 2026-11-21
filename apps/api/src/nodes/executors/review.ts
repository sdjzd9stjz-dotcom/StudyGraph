import type { NodeExecutor } from '../contract.ts'
import { ZERO_USAGE } from '../contract.ts'
import { currentMastery } from '../../domain/fsrs.ts'
import type { CardState } from '../../domain/fsrs.ts'

/**
 * `review` 执行器（M3）：生成复习计划。
 *
 * **不调模型**，纯 FSRS 计算。理由：下次什么时候该复习由记忆模型决定，
 * 这是可复现的数学；让模型"估一下"既不可复现，也没法解释为什么是这一天。
 *
 * 关键设计：
 * 1. **只排程，不代答**。它不写 Concept.mastery、不写 ReviewLog ——
 *    复习计划是"建议"，学生真的复习了才该产生记忆状态变化。
 *    计划节点自己改记忆强度，会让"复习"这个动作被系统替学生做了。
 * 2. **按到期时间排序，过期最久的排最前**。学生时间有限时先补欠得最多的。
 * 3. **新卡与到期卡分开**。新卡没有记忆历史，混在一起会让"今天该复习几张"
 *    这个数字失去意义（新卡不是"该复习"，是"还没开始"）。
 * 4. 没有可复习的卡时**明说原因**，不返回空计划假装一切正常。
 */

/** 一次计划最多排多少张：太多学生看不完，计划本身失去可执行性 */
const MAX_PLAN = 50

interface ReviewParams {
  /** 只看这一张画布（缺省 = 节点所在画布） */
  canvasId?: string
  /** 一次排几张，默认 20 */
  limit?: number
  /** 是否把从没复习过的新卡也排进来 */
  includeNew?: boolean
  /** 计划基准时间（ISO），缺省为现在。测试与"明早再看"都要用到 */
  asOf?: string
}

interface PlanItem {
  readonly conceptId: string
  readonly name: string
  readonly state: CardState
  readonly dueAt: string | null
  readonly overdueDays: number
  readonly retrievability: number
  readonly reason: 'OVERDUE' | 'DUE_TODAY' | 'NEW'
}

export const reviewExecutor: NodeExecutor<ReviewParams> = {
  type: 'REVIEW',
  artifactKind: 'REVIEW_PLAN',
  promptVersion: 'no-prompt',
  inputs: {
    type: 'object',
    properties: { cards: { type: 'object', description: '上游 card 节点产物（可选）' } },
    required: [],
  },
  outputs: {
    type: 'object',
    properties: {
      plan: { type: 'array' },
      summary: { type: 'object' },
    },
    required: ['plan', 'summary'],
  },

  async run(ctx) {
    const canvasId = ctx.params.canvasId ?? ctx.canvasId
    const limit = Math.min(MAX_PLAN, Math.max(1, ctx.params.limit ?? 20))
    const includeNew = ctx.params.includeNew ?? true
    const asOf = ctx.params.asOf ? new Date(ctx.params.asOf) : new Date()
    if (Number.isNaN(asOf.getTime())) throw new Error(`review 节点的 params.asOf 不是合法时间：${JSON.stringify(ctx.params.asOf)}`)

    // 只排「可复习」的卡：VERIFIED 才是学生该看到的；PENDING_REVIEW 还没过人工复核
    const concepts = await ctx.prisma.concept.findMany({
      where: { canvasId, status: 'VERIFIED' },
      orderBy: [{ dueAt: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        mastery: true,
        dueAt: true,
        lastReviewedAt: true,
        fsrsState: true,
      },
    })

    if (concepts.length === 0) {
      throw new Error(
        '画布上没有通过复核的概念卡（status=VERIFIED）。复习计划需要至少一张已确认的卡；' +
          '请先跑 card 节点并通过人工复核。',
      )
    }

    const items: PlanItem[] = []
    let notDue = 0
    let skippedNew = 0

    for (const concept of concepts) {
      const stored = (concept.fsrsState ?? {}) as { stability?: number; difficulty?: number; state?: CardState }
      const hasHistory = concept.lastReviewedAt !== null

      if (!hasHistory) {
        if (!includeNew) {
          skippedNew += 1
          continue
        }
        items.push({
          conceptId: concept.id,
          name: concept.name,
          state: 'NEW',
          dueAt: null,
          overdueDays: 0,
          retrievability: 0,
          reason: 'NEW',
        })
        continue
      }

      const state = {
        stability: stored.stability ?? 0,
        difficulty: stored.difficulty ?? 5,
        state: stored.state ?? 'REVIEW',
        lastReviewedAt: concept.lastReviewedAt as Date,
      }

      const dueAt = concept.dueAt
      if (!dueAt || dueAt.getTime() > asOf.getTime()) {
        notDue += 1
        continue
      }

      const overdueDays = (asOf.getTime() - dueAt.getTime()) / 86_400_000
      items.push({
        conceptId: concept.id,
        name: concept.name,
        state: state.state,
        dueAt: dueAt.toISOString(),
        overdueDays: Math.round(overdueDays * 10) / 10,
        // 现在的可提取概率：用来告诉学生"这张还能记住多少"
        retrievability: Math.round(currentMastery(state, asOf) * 1000) / 1000,
        reason: overdueDays >= 1 ? 'OVERDUE' : 'DUE_TODAY',
      })
    }

    // 过期最久的排最前：逾期 = 遗忘风险最高
    items.sort((a, b) => {
      if (a.reason === 'NEW' && b.reason !== 'NEW') return 1
      if (b.reason === 'NEW' && a.reason !== 'NEW') return -1
      return b.overdueDays - a.overdueDays
    })

    const plan = items.slice(0, limit)

    // 估算做完这份计划要多久：新卡 40 秒、复习卡 20 秒（保守值，宁可高估）
    const estimatedMinutes = Math.ceil(
      plan.reduce((sum, item) => sum + (item.reason === 'NEW' ? 40 : 20), 0) / 60,
    )

    return {
      outputs: {
        plan,
        summary: {
          asOf: asOf.toISOString(),
          totalConcepts: concepts.length,
          planned: plan.length,
          newCount: plan.filter((item) => item.reason === 'NEW').length,
          overdueCount: plan.filter((item) => item.reason === 'OVERDUE').length,
          dueTodayCount: plan.filter((item) => item.reason === 'DUE_TODAY').length,
          // 这些必须能被看见：截断与跳过都不能静默
          notDue,
          skippedNew,
          truncated: items.length > plan.length ? items.length - plan.length : 0,
          estimatedMinutes,
        },
      },
      usage: ZERO_USAGE,
    }
  },
}
