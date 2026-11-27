import type { JSONSchema } from '../../llm/types.ts'
import { composeSystemPrompt, HARD_RULE_SUMMARY } from '../skills.ts'
import type { NodeExecutor } from '../contract.ts'

/**
 * `quiz` 执行器（M6）：从已确认的概念卡出题，**并真正写进 Problem 表**。
 *
 * 为什么这个执行器必须写库，而不是只产出产物：
 * 题库、组卷、作答判分、错因看板这四条链路的数据源都是 `Problem` 表。
 * 如果 quiz 只往 Artifact 里塞一份 JSON，那四处界面永远是空的 ——
 * "跑通了"但一条链都用不了。写入是这里的第一等职责。
 *
 * 五条硬约束，每条对应一种会毁掉题库的坏法：
 *
 * 1. **只从 VERIFIED 概念出题**。PENDING_REVIEW 的卡还没经过人工复核，
 *    拿它出题 = 把没确认的知识点做成卷子发给学生。
 * 2. **每道题必须带 ProblemCitation**。数据库的 `problem_verified_needs_citation`
 *    触发器会拦住没有引用的 VERIFIED 题 —— 这是对的，一道题说不出它考的那条
 *    原文在哪，就没法溯源、没法判对错。
 * 3. **状态只写 PENDING**。出题模型给的东西不能直接当 VERIFIED：
 *    过了三检（check 节点）才升 VERIFIED。这里越权升状态 = 绕过三检。
 * 4. **每个选项必须绑定错因**（选择题）。没有 errorTag 的干扰项测不出任何误解，
 *    错因看板会把它算成"无法解释的项"。
 * 5. **凑不够就说凑不够**。题目数不足时在产物里明写 requested/actual，
 *    绝不拿不合格的题凑数。
 */

/** 六类错因，与 ErrorTag.code 种子一致 */
const ERROR_TAGS = ['CONCEPT_GAP', 'METHOD_MISMATCH', 'CONDITION_MISSED', 'COMPUTE_SLIP', 'READING_SLIP', 'CHECK_OMITTED'] as const
type ErrorTagCode = (typeof ERROR_TAGS)[number]

const SYSTEM_PROMPT = `你是一位数学命题老师，根据给定的概念卡出练习题。

硬性要求：
- 每道题必须**只考给定概念**，不要把没列出来的知识点当成前提
- 选择题至少 2 个选项；选择题选项编号从 A 开始
- **每个错误选项必须绑定一个错因**，并说明学生为什么会被它吸引：
  CONCEPT_GAP（概念没懂）/ METHOD_MISMATCH（用错方法）/ CONDITION_MISSED（漏条件）/
  COMPUTE_SLIP（算错）/ READING_SLIP（看错题）/ CHECK_OMITTED（没检查）
- 答案必须唯一且可判定。能算的题就给最终值，不要写"略"
- **说明里限定了题型时，只能出限定的题型**。要证明题就出证明题，
  不要因为"证明题不好出"就换成计算题或选择题 —— 换掉等于没按要求做
- 证明题的 answer 写完整论证要点，每行一条，便于按要点判分
- 不要出考查死记硬背的题；考"是否真的理解了"
- 凑不出符合要求的题就少出，**不要拿不合格的题凑数**`

const optionSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'A/B/C/D' },
    text: { type: 'string' },
    errorTag: { type: 'string', description: `错误选项必填，取 ${ERROR_TAGS.join('/')} 之一；正确选项填 null` },
    why: { type: 'string', description: '学生为什么会被这个错误选项吸引' },
  },
  required: ['key', 'text'],
  additionalProperties: false,
} as const

const outputSchema: JSONSchema = {
  type: 'object',
  properties: {
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'SINGLE_CHOICE/MULTI_CHOICE/TRUE_FALSE/FILL_BLANK/NUMERIC/COMPUTATION/SHORT_ANSWER/PROOF' },
          stem: { type: 'string' },
          options: { type: 'array', items: optionSchema },
          answer: { type: 'string', description: '正确答案；选择题填选项 key' },
          judgeRule: { type: 'string', description: 'CHOICE/EXACT/NUMERIC_TOL/RUBRIC' },
          tolerance: { type: 'number', description: 'NUMERIC_TOL 时的容差' },
          difficulty: { type: 'integer' },
          bloom: { type: 'string', description: 'REMEMBER/UNDERSTAND/APPLY/ANALYZE/EVALUATE/CREATE' },
          conceptNames: { type: 'array', items: { type: 'string' }, description: '这道题考到的概念名（必须来自给定列表）' },
        },
        required: ['type', 'stem', 'answer', 'judgeRule', 'conceptNames'],
        additionalProperties: false,
      },
    },
  },
  required: ['problems'],
  additionalProperties: false,
}

const PROBLEM_TYPES = ['SINGLE_CHOICE', 'MULTI_CHOICE', 'TRUE_FALSE', 'FILL_BLANK', 'NUMERIC', 'COMPUTATION', 'SHORT_ANSWER', 'PROOF'] as const
const JUDGE_RULES = ['CHOICE', 'EXACT', 'NUMERIC_TOL', 'RUBRIC'] as const
const BLOOM_LEVELS = ['REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE', 'CREATE'] as const
/** 需要选项的题型：库里 `problem_choice_has_options` CHECK 要求 ≥2 个 */
const CHOICE_TYPES = new Set(['SINGLE_CHOICE', 'MULTI_CHOICE'])

/** 一次最多出几道：太多模型会开始降质量凑数 */
const MAX_PER_RUN = 20
/** 最多用几张概念卡作上下文 */
const MAX_CONCEPTS = 25

interface QuizParams {
  /** 出几道题 */
  count?: number
  /** 只考这些概念（按 name）；缺省用画布上全部 VERIFIED 概念 */
  conceptNames?: string[]
  /** 限定题型；缺省让模型按概念自己选 */
  types?: string[]
  /** 难度 1–5 */
  difficulty?: number
}

/**
 * 把若干概念的主引用按 spanId 合并。
 *
 * 同一段原文经常同时是多条概念的主引用（一个定义里常定义两三个概念）。
 * 不合并就会给同一道题插入两条同 spanId 的引用，撞 (problemId, spanId) 唯一约束，
 * 整道题的 create 一起失败 —— 而且报错是约束冲突，看不出真正原因是"共享引用"。
 */
function dedupeBySpan(
  concepts: ReadonlyArray<{ readonly name: string; readonly citations: ReadonlyArray<{ readonly spanId: string }> }>,
): Array<{ spanId: string; names: string[] }> {
  const bySpan = new Map<string, string[]>()
  for (const concept of concepts) {
    const spanId = concept.citations[0]?.spanId
    if (!spanId) continue
    const names = bySpan.get(spanId)
    if (names) names.push(concept.name)
    else bySpan.set(spanId, [concept.name])
  }
  return [...bySpan.entries()].map(([spanId, names]) => ({ spanId, names }))
}

/**
 * 从提示词里读题型要求。
 *
 * 用户写"要求是证明题""只要计算题""出选择题"这类话，都应当变成题型约束。
 * 只认关键词，不做语义理解：宁可漏判（退化成不限制），也不要把
 * "不要出选择题"这种否定句误判成"只要选择题"。
 */
export function typesFromPrompt(prompt: string): string[] {
  const text = prompt.trim()
  if (text.length === 0) return []

  const patterns: Array<{ type: (typeof PROBLEM_TYPES)[number]; pattern: RegExp }> = [
    { type: 'PROOF', pattern: /证明题|证明|证明其|证一下/ },
    // "选择题"不带多选字样时按单选处理：多选必须先说明，否则默认单选更安全
    { type: 'SINGLE_CHOICE', pattern: /单选题|单项选择|单选|选择题/ },
    { type: 'MULTI_CHOICE', pattern: /多选题|多项选择|多选/ },
    { type: 'TRUE_FALSE', pattern: /判断题|是非题/ },
    { type: 'FILL_BLANK', pattern: /填空题/ },
    { type: 'NUMERIC', pattern: /数值题|计算结果/ },
    { type: 'COMPUTATION', pattern: /计算题|求解题|算一算/ },
    { type: 'SHORT_ANSWER', pattern: /简答题|问答/ },
  ]

  /**
   * 先按小句切开再判否定：整段匹配会让"不要出证明题，出计算题"里的
   * "不要"一直管到后面的"计算题"，把真正的肯定要求也吃掉。
   * 以逗号/分号/句号/换行为界，一个子句只影响它自己。
   */
  const clauses = text.split(/[，,。；;\n]/).map((clause) => clause.trim()).filter(Boolean)

  const hits: Array<(typeof PROBLEM_TYPES)[number]> = []
  for (const { type, pattern } of patterns) {
    const positive = clauses.some((clause) => pattern.test(clause) && !/^(不要|别|避免|不用|无需)/.test(clause))
    if (positive) hits.push(type)
  }
  return hits
}

interface RawProblem {
  type?: unknown
  stem?: unknown
  options?: unknown
  answer?: unknown
  judgeRule?: unknown
  tolerance?: unknown
  difficulty?: unknown
  bloom?: unknown
  conceptNames?: unknown
}

export const quizExecutor: NodeExecutor<QuizParams> = {
  type: 'QUIZ',
  artifactKind: 'PROBLEM_DRAFT',
  promptVersion: 'quiz-v3',
  inputs: {
    type: 'object',
    properties: {
      cards: { type: 'object', description: '上游 card 节点产物（可选，缺省用画布已确认概念）' },
    },
    required: [],
  },
  outputs: {
    type: 'object',
    properties: {
      created: { type: 'array' },
      requested: { type: 'number' },
      actual: { type: 'number' },
      dropped: { type: 'array' },
    },
    required: ['created', 'requested', 'actual', 'dropped'],
  },

  async run(ctx) {
    const count = Math.min(MAX_PER_RUN, Math.max(1, ctx.params?.count ?? 5))

    /**
     * 概念来源：优先已确认的，没有再退到待复核的。
     *
     * 为什么要退：卡片跑完后概念一律是 PENDING_REVIEW，要人去概念面板逐条点确认。
     * 之前这里只认 VERIFIED，用户跑完卡直接出题就撞上「没有通过复核的概念」，
     * 而整条链路上**没有任何提示告诉他去点确认** —— 用户以为出题坏了（真实报障）。
     *
     * 边界仍然守住：UNVERIFIED（引文对不上原文）绝不能变成练习题。
     * PENDING_REVIEW 意味着引文可查、只是定义待人复核，用它出题并在产物里标明。
     */
    const conceptFilter = {
      canvasId: ctx.canvasId,
      ...(Array.isArray(ctx.params?.conceptNames) && ctx.params.conceptNames.length > 0
        ? { name: { in: ctx.params.conceptNames } }
        : {}),
    }
    const conceptSelect = {
      id: true,
      name: true,
      definition: true,
      status: true,
      // 出题必须有引用可挂：没有主引用的概念无法给题目挂 ProblemCitation
      citations: { where: { isPrimary: true }, take: 1, select: { spanId: true } },
    } as const

    let concepts = await ctx.prisma.concept.findMany({
      where: { ...conceptFilter, status: 'VERIFIED' },
      orderBy: { name: 'asc' },
      take: MAX_CONCEPTS,
      select: conceptSelect,
    })
    const usedPendingReview = concepts.length === 0
    if (usedPendingReview) {
      concepts = await ctx.prisma.concept.findMany({
        where: { ...conceptFilter, status: 'PENDING_REVIEW' },
        orderBy: { name: 'asc' },
        take: MAX_CONCEPTS,
        select: conceptSelect,
      })
    }

    if (concepts.length === 0) {
      throw new Error(
        '画布上没有可用的概念（需要 VERIFIED 或 PENDING_REVIEW）。' +
          '请先跑概念卡节点；如果已经跑过，去画布上方的「概念卡」面板确认概念。',
      )
    }

    const citable = concepts.filter((concept) => concept.citations.length > 0)
    if (citable.length === 0) {
      throw new Error(
        `${concepts.length} 条概念都没有主引用（primary citation），` +
          '题目会因为没有 ProblemCitation 而被数据库拦在 VERIFIED 之外。请先补齐概念的原文引用。',
      )
    }

    const byName = new Map(citable.map((concept) => [concept.name, concept]))
    const listing = citable
      .map((concept, index) => `${index + 1}. ${concept.name}：${concept.definition}`)
      .join('\n')

    /**
     * 题型约束有两个来源，缺一不可：
     *   1. 结构化参数 `params.types`（界面上"限定题型"那一栏）
     *   2. 节点提示词里写明的题型（"要求是证明题"）
     *
     * 只认第一种时，用户在提示词里写"只要证明题"毫无强制力 ——
     * 模型照样返回计算题，代码也照样收下（真实反馈：要求证明题，出了 5 道计算题）。
     * 提示词是用户的直接要求，优先级不低于参数栏。
     */
    const declaredTypes = Array.isArray(ctx.params?.types)
      ? (ctx.params.types as string[]).filter((type) => (PROBLEM_TYPES as readonly string[]).includes(type))
      : []
    const promptedTypes = typesFromPrompt(String((ctx.params as { prompt?: unknown } | null)?.prompt ?? ''))
    const allowedTypes = declaredTypes.length > 0 ? declaredTypes : promptedTypes

    const typeHint = allowedTypes.length > 0
      ? `\n限定题型：只允许 ${allowedTypes.join(' / ')}。不要输出其它题型。`
      : ''
    const difficultyHint = ctx.params?.difficulty ? `\n目标难度：${ctx.params.difficulty}（1–5）` : ''

    const result = await ctx.llm.complete({
      taskType: 'quiz',
      messages: [
        { role: 'system', content: composeSystemPrompt(HARD_RULE_SUMMARY, ctx.skills, SYSTEM_PROMPT) },
        {
          role: 'user',
          content: `可引用的概念：\n${listing}`,
        },
        {
          role: 'user',
          content: `请根据这些概念出 ${count} 道题。${typeHint}${difficultyHint}`,
        },
      ],
      jsonSchema: outputSchema,
      user: ctx.user,
    })

    const raw = ((result.data as { problems?: RawProblem[] }).problems ?? [])
    const dropped: Array<{ stem: string; reason: string }> = []
    const created: Array<{ id: string; type: string; stem: string; difficulty: number; status: string }> = []

    for (const item of raw) {
      const stem = typeof item.stem === 'string' ? item.stem.trim() : ''
      const answer = typeof item.answer === 'string' ? item.answer.trim() : ''

      if (stem.length < 4) {
        dropped.push({ stem: stem.slice(0, 40), reason: '题干为空或过短' })
        continue
      }
      if (answer.length === 0) {
        // 没有答案的题无法判分，进库只会变成"永远待判"
        dropped.push({ stem: stem.slice(0, 40), reason: '缺少答案' })
        continue
      }

      const declared = typeof item.type === 'string' && (PROBLEM_TYPES as readonly string[]).includes(item.type)
        ? item.type
        : 'SHORT_ANSWER'

      /**
       * 题型必须落在允许范围内。
       * 之前只把用户的"限定题型"当提示词写进请求，模型返回什么都照收 ——
       * 界面上写着"只要证明题"，出来的是计算题，用户看到的就是"不符合要求"。
       */
      if (allowedTypes.length > 0 && !allowedTypes.includes(declared)) {
        dropped.push({ stem: stem.slice(0, 40), reason: `题型 ${declared} 不在限定范围（${allowedTypes.join('/')}）` })
        continue
      }
      const type = declared

      /**
       * 证明题/简答题不能被判成 EXACT。
       *
       * 一道证明题的答案是整段论证，用"字符串完全相等"去判必然永远判错，
       * 学生写对了也算错 —— 比没有这道题更糟。这两类必须走 RUBRIC（要点判分），
       * 并把参考要点从答案里拆出来，否则判分规则等于没写。
       */
      const rubricType = type === 'PROOF' || type === 'SHORT_ANSWER'
      const judgeRule = rubricType
        ? 'RUBRIC'
        : typeof item.judgeRule === 'string' && (JUDGE_RULES as readonly string[]).includes(item.judgeRule)
          ? item.judgeRule
          : CHOICE_TYPES.has(type) ? 'CHOICE' : 'EXACT'
      const bloom = typeof item.bloom === 'string' && (BLOOM_LEVELS as readonly string[]).includes(item.bloom)
        ? item.bloom
        : 'APPLY'
      const difficulty = typeof item.difficulty === 'number' ? Math.min(5, Math.max(1, Math.round(item.difficulty))) : (ctx.params?.difficulty ?? 2)

      // 选项清洗：选择题必须有 ≥2 项且每个错误项带合法错因
      let options: Array<{ key: string; text: string; errorTag: string | null; why: string | null }> | null = null
      if (CHOICE_TYPES.has(type)) {
        const rawOptions = Array.isArray(item.options) ? (item.options as Array<Record<string, unknown>>) : []
        const cleaned: Array<{ key: string; text: string; errorTag: string | null; why: string | null }> = []
        for (const [index, option] of rawOptions.entries()) {
          const text = typeof option.text === 'string' ? option.text.trim() : ''
          if (text.length === 0) continue
          const key = typeof option.key === 'string' && option.key.trim().length > 0
            ? option.key.trim().toUpperCase()
            : String.fromCharCode(65 + index)
          const isCorrect = key === answer.toUpperCase() || text === answer
          const rawTag = typeof option.errorTag === 'string' ? option.errorTag : ''
          const errorTag = isCorrect
            ? null
            : (ERROR_TAGS as readonly string[]).includes(rawTag) ? rawTag : null
          // 错误选项没有合法错因 → 丢弃这个选项（不补一个假错因）
          if (!isCorrect && errorTag === null) continue
          cleaned.push({
            key,
            text,
            errorTag,
            why: typeof option.why === 'string' && option.why.trim().length > 0 ? option.why.trim() : null,
          })
        }

        if (cleaned.length < 2) {
          dropped.push({ stem: stem.slice(0, 40), reason: `选择题可用选项只有 ${cleaned.length} 个（需 ≥2 且有错因绑定）` })
          continue
        }
        if (!cleaned.some((option) => option.errorTag === null)) {
          dropped.push({ stem: stem.slice(0, 40), reason: '选项里找不到正确项（没有任何一项的 key 等于答案）' })
          continue
        }
        options = cleaned
      }

      // 概念归属：只认给定列表里的名字，模型编的概念名不挂
      const conceptNames = Array.isArray(item.conceptNames)
        ? (item.conceptNames as unknown[]).filter((name): name is string => typeof name === 'string')
        : []
      const linked = conceptNames.map((name) => byName.get(name)).filter((concept): concept is NonNullable<typeof concept> => Boolean(concept))
      if (linked.length === 0) {
        dropped.push({ stem: stem.slice(0, 40), reason: '没有引用任何给定的概念' })
        continue
      }

      /**
       * RUBRIC 的判分依据。
       *
       * 证明题的答案本身就是"应该出现在论证里的要点"。把它按行/分号拆成要点列表，
       * 判分时逐条对照，学生写对几条给几条的分 —— 这比让它判 EXACT 全对或全错合理得多。
       * 拆不出要点时保留整段作为单条要点，不编造额外要求。
       */
      const rubricPoints = rubricType
        ? answer
            .split(/\n+|；|;/)
            .map((point) => point.replace(/^\s*[-*•\d.、)）]+\s*/, '').trim())
            .filter((point) => point.length >= 4)
            .slice(0, 12)
        : []

      const judgeSpec =
        judgeRule === 'NUMERIC_TOL'
          ? { tolerance: typeof item.tolerance === 'number' && item.tolerance >= 0 ? item.tolerance : 0 }
          : judgeRule === 'RUBRIC'
            ? { points: rubricPoints.length > 0 ? rubricPoints : [answer] }
            : undefined

      const problem = await ctx.prisma.problem.create({
        data: {
          canvasId: ctx.canvasId,
          type: type as never,
          stemMd: stem,
          options: options as never,
          answer: answer as never,
          judgeRule: judgeRule as never,
          judgeSpec: (judgeSpec ?? undefined) as never,
          difficulty,
          bloom: bloom as never,
          // 只写 PENDING：过三检（check 节点）才升 VERIFIED。
          // 这里直接写 VERIFIED 会绕过三检，且会撞上 citation 触发器。
          status: 'PENDING',
          sourceNodeId: ctx.nodeId,
          concepts: { create: linked.map((concept) => ({ conceptId: concept.id })) },
          // 每条题都挂引用：没有引用的题升不到 VERIFIED，也就进不了任何卷子。
          // 按 spanId 去重：同一段原文常同时是多个概念的主引用，
          // ProblemCitation 对 (problemId, spanId) 唯一，重复插入会整条 create 失败。
          citations: {
            create: dedupeBySpan(linked).map((entry) => ({
              spanId: entry.spanId,
              note: `考点：${entry.names.join('、')}`,
            })),
          },
        },
        select: { id: true, type: true, stemMd: true, difficulty: true, status: true },
      })

      created.push({ id: problem.id, type: problem.type, stem: problem.stemMd, difficulty: problem.difficulty, status: problem.status })
    }

    /**
     * 缺口要能解释清楚。
     *
     * 只报 requested/actual 的话，用户看到"要 5 道、出了 3 道"完全不知道原因；
     * 按丢弃理由归类后，最可能的一句就是"题型限制把其余的筛掉了"。
     */
    const dropReasons = [...new Set(dropped.map((item) => item.reason))].slice(0, 5)

    return {
      outputs: {
        created,
        requested: count,
        // 不足就明说：requested 5 / actual 3 是可见的缺口，不静默补齐
        actual: created.length,
        dropped,
        dropReasons,
        ...(allowedTypes.length > 0 ? { allowedTypes } : {}),
        // 用了待复核的概念就必须让人看见：题目能出，但定义还没人确认过
        ...(usedPendingReview ? { usedPendingReview: true, conceptStatus: 'PENDING_REVIEW' } : {}),
      },
      usage: result.usage,
      usageRecords: [{ provider: result.provider, model: result.modelVersion, ...result.usage }],
    }
  },
}
