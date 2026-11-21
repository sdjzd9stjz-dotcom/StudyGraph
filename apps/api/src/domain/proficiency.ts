/**
 * 方法熟练度（M5，规格「双熟练度模型」）。
 *
 * 规格原文：
 *   - 概念用 FSRS 调度复习（mastery / dueAt / fsrsState）
 *   - 方法用「近期调用成功率 + 迁移成功率」计算熟练度（proficiency / lastUsedAt）
 *   - **禁止把两者合并为单一 mastery 字段**
 *
 * 为什么不能合并：一个概念可以记得很牢但完全不会用；一个方法可以背得滚瓜烂熟
 * 但换个情境就失效。合并会摧毁平台的核心诊断能力 —— 学生看到"85 分"，
 * 却分不清是该去复习概念，还是该做迁移练习。
 *
 * 这里的 proficiency 是 `MethodApplication` 的派生量，不是手填字段。
 */

export interface ApplicationRecord {
  readonly isCorrect: boolean
  /** 与该方法"学习情境"不同的题目上发生的调用 */
  readonly isTransfer: boolean
  /** 方法误用：选错方法 / 条件不满足仍使用 */
  readonly isMisuse: boolean
  readonly usedAt: Date
}

export interface ProficiencyResult {
  readonly proficiency: number
  readonly reps: number
  readonly successes: number
  readonly transferReps: number
  readonly transferSuccesses: number
  readonly misuseCount: number
  readonly lastUsedAt: Date | null
  /** 用于界面解释"这个分数怎么来的" */
  readonly breakdown: {
    readonly recentSuccess: number
    readonly transferRate: number
    readonly recencyWeight: number
  }
}

/** 近期窗口：只看最近这些天的调用（更早的算"历史"，权重很低） */
const RECENT_WINDOW_DAYS = 30
/** 迁移样本太少时，迁移率不可信，往 0.5 收缩 */
const TRANSFER_PRIOR = 0.5
const TRANSFER_PSEUDO_COUNT = 2

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/**
 * 计算一个方法的熟练度。
 *
 * 三个分量：
 *   1. 近期成功率（权重 0.55）—— 最近做对的比率，带时间衰减
 *   2. 迁移成功率（权重 0.35）—— 换情境还能不能做对，这是"真会"的关键
 *   3. 误用惩罚（权重 0.10 的反向）—— 用错方法比做错更严重
 *
 * 为什么迁移单独算：只在一个题型上刷对 20 遍，不等于掌握方法。
 * 规格把「迁移成功率」写进公式，就是为了防这个。
 */
export function computeProficiency(applications: readonly ApplicationRecord[], now: Date = new Date()): ProficiencyResult {
  if (applications.length === 0) {
    return {
      proficiency: 0,
      reps: 0,
      successes: 0,
      transferReps: 0,
      transferSuccesses: 0,
      misuseCount: 0,
      lastUsedAt: null,
      breakdown: { recentSuccess: 0, transferRate: 0, recencyWeight: 0 },
    }
  }

  const windowStart = now.getTime() - RECENT_WINDOW_DAYS * 86_400_000
  let weightedTotal = 0
  let weightedCorrect = 0

  for (const record of applications) {
    const age = now.getTime() - record.usedAt.getTime()
    // 半衰期 14 天：两周前的作答权重减半
    const weight = Math.exp(-age / (14 * 86_400_000))
    weightedTotal += weight
    if (record.isCorrect) weightedCorrect += weight
    void windowStart
  }

  const recentSuccess = weightedTotal > 0 ? weightedCorrect / weightedTotal : 0

  const transfer = applications.filter((record) => record.isTransfer)
  const transferSuccesses = transfer.filter((record) => record.isCorrect).length
  // 贝叶斯收缩：样本少时不要给出极端值（做对 1 次迁移 ≠ 100% 会迁移）
  const transferRate =
    (transferSuccesses + TRANSFER_PRIOR * TRANSFER_PSEUDO_COUNT) / (transfer.length + TRANSFER_PSEUDO_COUNT)

  const misuseCount = applications.filter((record) => record.isMisuse).length
  const misuseRate = misuseCount / applications.length

  const raw = 0.55 * recentSuccess + 0.35 * transferRate + 0.1 * (1 - misuseRate)
  // 第一次就做对不该直接到 1 分：样本越少，往 0 收缩得越多
  const confidence = applications.length / (applications.length + 3)
  const proficiency = clamp01(raw * confidence)

  const lastUsedAt = applications.reduce<Date | null>(
    (latest, record) => (!latest || record.usedAt > latest ? record.usedAt : latest),
    null,
  )

  return {
    proficiency: Number(proficiency.toFixed(4)),
    reps: applications.length,
    successes: applications.filter((record) => record.isCorrect).length,
    transferReps: transfer.length,
    transferSuccesses,
    misuseCount,
    lastUsedAt,
    breakdown: {
      recentSuccess: Number(recentSuccess.toFixed(4)),
      transferRate: Number(transferRate.toFixed(4)),
      recencyWeight: Number(confidence.toFixed(4)),
    },
  }
}

/**
 * 判定两次调用是否属于"同一情境"（用于 isTransfer）。
 *
 * 情境 = 题型 + 概念组合。概念组合排序后比较，顺序不同不算换情境。
 */
export function buildContextKey(problemType: string, conceptIds: readonly string[]): string {
  return `${problemType}|${[...conceptIds].sort().join(',')}`
}

/**
 * 回写方法熟练度。
 *
 * 调用时机：每次作答落库后。不做定时任务 —— 熟练度是学生看得到的即时反馈，
 * 延迟更新会让"我明明做对了怎么分数没变"变成困惑。
 */
export async function refreshMethodProficiency(
  prisma: {
    methodApplication: {
      findMany: (args: unknown) => Promise<Array<{ isCorrect: boolean; isTransfer: boolean; isMisuse: boolean; usedAt: Date }>>
    }
    method: { update: (args: unknown) => Promise<unknown> }
  },
  methodId: string,
  now: Date = new Date(),
): Promise<ProficiencyResult> {
  const applications = await prisma.methodApplication.findMany({
    where: { methodId },
    select: { isCorrect: true, isTransfer: true, isMisuse: true, usedAt: true },
  })

  const result = computeProficiency(applications, now)
  await prisma.method.update({
    where: { id: methodId },
    data: { proficiency: result.proficiency, lastUsedAt: result.lastUsedAt },
  })
  return result
}
