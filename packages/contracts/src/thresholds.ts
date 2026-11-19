/**
 * 跨模块共享的阈值。禁止在组件或执行器里写魔法数——
 * 阈值改动要能在一个地方被看见（例如"proficiency < 0.6 画虚线"）。
 */

/** 方法熟练度低于此值，方法视图给虚线边框、列表排到后面。 */
export const PROFICIENCY_LOW_THRESHOLD = 0.6

/** 干扰项"量级荒谬"的判定：|option - answer| / |answer| > 10 视为凑数。 */
export const DISTRACTOR_MAGNITUDE_LIMIT = 10

/** 选择题最少选项数（含正确答案）。 */
export const MIN_CHOICE_OPTIONS = 2

/** 选择题最少干扰项数：一道单选至少要有 2 个有诊断价值的错项。 */
export const MIN_DISTRACTORS = 2

/** FSRS：新卡首次间隔上限（天），防止一次评分把间隔拉得过长。 */
export const FSRS_MAX_INITIAL_INTERVAL_DAYS = 14

/** 指纹命中缓存时 Run.tokensIn/Out 记 0，这是"不消耗 token"的验收依据。 */
export const CACHE_HIT_TOKENS = 0
