/**
 * FSRS-4.5 排程器（M3 · review 节点）。
 *
 * 为什么自己实现而不是拍脑袋写"答对加一天、答错重置"：
 * SM-2 那套在现代复习理论里已经过时，FSRS 用**可提取性 R** 决定间隔，
 * 才能在"记得的学生别浪费时间"和"忘掉的学生别断链"之间取平衡。
 * 参数取自官方 FSRS-4.5 默认权重；以后可以按 ReviewLog 拟合，但现在先跑通。
 *
 * 公式与符号统一用 FSRS 论文口径：
 *   R(t,S) = (1 + FACTOR · t/S)^DECAY     可提取性；t 天后还记得的概率
 *   I(R,S) = (S/FACTOR) · (R^(1/DECAY) - 1)  达到目标保留率所需的间隔
 */

/** FSRS-4.5 默认权重（19 个） */
export const DEFAULT_WEIGHTS = [
  0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616, 0.1544,
  1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034, 0.6567,
] as const

const DECAY = -0.5
const FACTOR = 19 / 81

export type Grade = 'AGAIN' | 'HARD' | 'GOOD' | 'EASY'
export type CardState = 'NEW' | 'LEARNING' | 'REVIEW' | 'RELEARNING'

const GRADE_VALUE: Record<Grade, 1 | 2 | 3 | 4> = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 }

export interface FsrsState {
  readonly stability: number
  readonly difficulty: number
  readonly state: CardState
  /** 上次复习时间；NEW 卡为 null */
  readonly lastReviewedAt: Date | null
}

export interface ScheduleInput {
  readonly state: FsrsState | null
  readonly grade: Grade
  readonly now: Date
  /** 目标保留率，默认 0.9（FSRS 推荐值） */
  readonly desiredRetention?: number
  readonly weights?: readonly number[]
}

export interface ScheduleResult {
  readonly stability: number
  readonly difficulty: number
  readonly state: CardState
  readonly scheduledDays: number
  readonly dueAt: Date
  readonly elapsedDays: number
  /** 0..1，当前掌握度（= 此刻的可提取性） */
  readonly mastery: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** 可提取性：距今 t 天时仍能回忆的概率。S 为 0 时视为忘光。 */
export function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0
  if (elapsedDays <= 0) return 1
  return Math.pow(1 + FACTOR * (elapsedDays / stability), DECAY)
}

/** 由可提取性反推间隔（天）。 */
export function intervalForRetention(retention: number, stability: number): number {
  const r = clamp(retention, 0.01, 0.99)
  return (stability / FACTOR) * (Math.pow(r, 1 / DECAY) - 1)
}

/** 初始稳定性 S0(G) = w[G-1] */
function initialStability(grade: Grade, w: readonly number[]): number {
  return w[GRADE_VALUE[grade] - 1] ?? w[2]!
}

/** 初始难度 D0(G) = w[4] - e^(w[5]·(G-1)) + 1，夹在 [1,10] */
function initialDifficulty(grade: Grade, w: readonly number[]): number {
  return clamp(w[4]! - Math.exp(w[5]! * (GRADE_VALUE[grade] - 1)) + 1, 1, 10)
}

/**
 * 排一次复习。
 *
 * 两个必须成立的性质（下方单测会盯住）：
 *   · 同一张卡连续 GOOD，间隔必须单调不降 —— 否则学生会被反复打断
 *   · AGAIN 必须把卡打进 LEARNING/RELEARNING 并把稳定性压回去
 */
export function schedule(input: ScheduleInput): ScheduleResult {
  const w = input.weights ?? DEFAULT_WEIGHTS
  const now = input.now
  const retention = input.desiredRetention ?? 0.9
  const previous = input.state

  const elapsedDays = previous?.lastReviewedAt
    ? Math.max(0, (now.getTime() - previous.lastReviewedAt.getTime()) / 86_400_000)
    : 0

  let stability: number
  let difficulty: number

  const isNew = !previous || previous.state === 'NEW' || previous.stability <= 0

  if (isNew) {
    stability = initialStability(input.grade, w)
    difficulty = initialDifficulty(input.grade, w)
  } else if (elapsedDays < 1) {
    // 同一天内的多次复习：FSRS-4.5 的短时公式，避免"反复点 GOOD 把间隔刷上天"
    const s = previous.stability
    const shortTerm = s * Math.exp(w[17]! * (GRADE_VALUE[input.grade] - 3 + w[18]!))
    stability = clamp(shortTerm, 0.01, 36_500)
    difficulty = clamp(previous.difficulty - w[6]! * (GRADE_VALUE[input.grade] - 3), 1, 10)
  } else {
    const r = retrievability(elapsedDays, previous.stability)
    // 难度先按评分调整，再向初始难度做均值回归（防止一路 EASY 把难度压到 1 再也升不回来）
    const adjusted = previous.difficulty - w[6]! * (GRADE_VALUE[input.grade] - 3)
    difficulty = clamp(w[7]! * initialDifficulty('EASY', w) + (1 - w[7]!) * adjusted, 1, 10)

    if (input.grade === 'AGAIN') {
      // 遗忘：稳定性按遗忘曲线回落，而不是简单重置
      stability = clamp(
        w[11]! * Math.pow(previous.difficulty, -w[12]!) * (Math.pow(previous.stability + 1, w[13]!) - 1) * Math.exp(w[14]! * (1 - r)),
        0.01,
        36_500,
      )
    } else {
      const hardPenalty = input.grade === 'HARD' ? w[15]! : 1
      const easyBonus = input.grade === 'EASY' ? w[16]! : 1
      stability = clamp(
        previous.stability *
          (1 + Math.exp(w[8]!) * (11 - previous.difficulty) * Math.pow(previous.stability, -w[9]!) * (Math.exp(w[10]! * (1 - r)) - 1) * hardPenalty * easyBonus),
        0.01,
        36_500,
      )
    }
  }

  const scheduledDays = Math.max(0.05, intervalForRetention(retention, stability))
  const dueAt = new Date(now.getTime() + scheduledDays * 86_400_000)

  const stateAfter: CardState =
    input.grade === 'AGAIN'
      ? previous && (previous.state === 'REVIEW' || previous.state === 'RELEARNING')
        ? 'RELEARNING'
        : 'LEARNING'
      : scheduledDays >= 1
        ? 'REVIEW'
        : 'LEARNING'

  return {
    stability,
    difficulty,
    state: stateAfter,
    scheduledDays,
    dueAt,
    elapsedDays,
    // 掌握度 = 现在的可提取性：刚复习完接近 1，长期不复习自然衰减
    mastery: retrievability(0, stability),
  }
}

/** 当前掌握度（两个复习日之间会自然下降，热力图才有意义）。 */
export function currentMastery(state: FsrsState, now: Date): number {
  if (!state.lastReviewedAt) return 0
  const elapsed = Math.max(0, (now.getTime() - state.lastReviewedAt.getTime()) / 86_400_000)
  return retrievability(elapsed, state.stability)
}
