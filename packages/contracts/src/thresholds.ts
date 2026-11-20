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

/**
 * 文字层可用性闸门（SG-SUP-008 §2.3）。
 *
 * 两层判定：先看"有没有文字"（全文 0 字符 → 无文字层），
 * 再看"文字能不能用"（劣质 OCR 的乱码页会被这里拦下）。
 */
export const TEXT_LAYER = {
  /** 标准 A：一页至少这么多字符才算"有效页" */
  minEffectivePageChars: 20,
  /** 标准 A：有效页占比低于这个值 → 不可用（数学分析 30/261=11.5% 会被拦，ch3-4 56% 放行） */
  minEffectivePageRatio: 0.2,
  /** 标准 B-1：康熙部首/兼容汉字占比超过它 → 异常 */
  maxKangxiRatio: 0.01,
  /** 标准 B-2：无元音的拉丁串占拉丁串比例超过它 → 异常 */
  maxVowelLessLatinRatio: 0.5,
  /** 标准 B-3：单字符页占"有字符页"的比例超过它 → 异常 */
  maxSingleCharPageRatio: 0.3,
  /** 三条乱码特征里至少命中几条才判"不可用" */
  minGibberishSignals: 2,
} as const

/**
 * 三档判定的阈值（SG-SUP-010 §1.4–1.5）。
 *
 * T2（PENDING_REVIEW）= 引文逐字可查 + 定义是转述。判定只用字符 bigram Jaccard，
 * 纯机械、可复现、**没有模型参与**（自己出题自己答不算判据）。
 *
 * 014 新批次中，目录型弱引文最高 J=0.520，正确切线转述 J=0.537。
 * 当前取两者之间的 0.53；逐条复核记录见 docs/交付/校准证据-014-真实候选.md。
 */
export const REVIEW_MIN_BIGRAM_SIMILARITY = 0.53

/** 定义长度 / 引文长度 的允许区间：太短往往是空话，太长往往是加了外部知识 */
export const REVIEW_MIN_LENGTH_RATIO = 0.5
export const REVIEW_MAX_LENGTH_RATIO = 2.0

/**
 * 谓词必须来自"名称之外"（SG-SUP-011 §2.2）。
 *
 * 「指数函数练习目录」里名称自带「指」，旧实现直接在整句上测谓词，
 * 于是纯标题被判成了定义。现在先去掉名称得到 residual，只在 residual 上测，
 * 并要求 residual 足够长——残差太短说明这句话只是标题。
 */
export const MIN_RESIDUAL_CHARS = 6



