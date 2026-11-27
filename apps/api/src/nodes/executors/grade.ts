import type { JSONSchema, TokenUsage } from '../../llm/types.ts'
import { buildContextKey, refreshMethodProficiency } from '../../domain/proficiency.ts'
import { composeSystemPrompt, HARD_RULE_SUMMARY } from '../skills.ts'
import type { NodeExecutor, NodeExecutorRunCtx } from '../contract.ts'

/**
 * `grade` 执行器（M6）：批量批改，**并把作答结果写进 Attempt**。
 *
 * 与 `POST /v1/problems/:id/attempts` 的分工：
 *   · 那个接口是**学生在界面上做题**，一次一道，即时判分
 *   · 这里是**老师一次性批改一批**（导入名单、纸质作业转录），批量、可无人值守
 * 两者写同一张 `Attempt` 表，判分口径共用下面的 `judgeDeterministic`，
 * 不各写一套 —— 否则同一份答案在界面上对、批量批改错，没人能解释。
 *
 * 四条硬约束：
 *
 * 1. **确定性判分优先**。EXACT / CHOICE / NUMERIC_TOL 全部本地算，不调模型。
 *    让模型判"1+1=2"，既慢又可能判错，且两次结果可能不同。
 * 2. **RUBRIC 标为待判，不假装判了**。`isCorrect = null` 是"还没判"的显式表达。
 *    写成 false 会把没判的题算成错题，污染错因统计。
 * 3. **错因来自选项自带的 errorTag**，不让模型事后编。
 *    这道题选了哪个选项，就暴露了哪类误解 —— 这是本项目的核心设计。
 * 4. **熟练度回写必须带情境指纹**。没有 contextKey 就分不清"做过同类题"
 *    和"把方法迁移到了新情境"，迁移成功率永远是 0。
 */

/** 一次最多批几道：批量接口要防失控 */
const MAX_GRADES = 200

const SYSTEM_PROMPT = `你是数学阅卷助手。按给定的评分步骤逐条判断学生作答是否满足。

硬性要求：
- 只依据给出的评分步骤判断，不要自己另立标准
- 每一步给出 pass/fail 和一句依据（引用学生答案里的具体内容）
- 全部步骤都满足才算正确；部分满足算不正确，并在理由里说清差在哪一步
- 看不懂学生的表达时判 fail 并说明，**不要猜测学生的意图**`

const outputSchema: JSONSchema = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          order: { type: 'integer' },
          pass: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['order', 'pass', 'reason'],
        additionalProperties: false,
      },
    },
    isCorrect: { type: 'boolean' },
  },
  required: ['steps', 'isCorrect'],
  additionalProperties: false,
}

interface GradeItem {
  problemId: string
  answer: string
  /** 学生这次用了哪个方法（可选，用于回写熟练度） */
  methodId?: string
  timeSpentSec?: number
}

interface GradeParams {
  /** 要批的作答；缺省则批这张画布下所有未判的 RUBRIC 作答 */
  items?: GradeItem[]
}

const norm = (value: unknown): string => String(value ?? '').trim().toLowerCase()

/**
 * 确定性判分。返回 null = 需要模型/人工（RUBRIC），不是"错"。
 *
 * 与 `routes/attempts.ts` 保持同一口径 —— 两处判分规则必须一致。
 */
function judgeDeterministic(
  rule: string,
  spec: unknown,
  expected: unknown,
  submitted: unknown,
): { isCorrect: boolean | null; detail: Record<string, unknown> } {
  if (rule === 'CHOICE' || rule === 'EXACT') {
    return {
      isCorrect: norm(expected) === norm(submitted),
      detail: { rule, expected: norm(expected), submitted: norm(submitted) },
    }
  }

  if (rule === 'NUMERIC_TOL') {
    const tolerance = Number((spec as { tolerance?: unknown } | null)?.tolerance ?? 0)
    const actual = Number(submitted)
    const target = Number(expected)
    if (!Number.isFinite(actual) || !Number.isFinite(target)) {
      return { isCorrect: false, detail: { rule, reason: 'NOT_A_NUMBER' } }
    }
    return {
      isCorrect: Math.abs(actual - target) <= tolerance,
      detail: { rule, target, actual, tolerance, diff: Math.abs(actual - target) },
    }
  }

  return { isCorrect: null, detail: { rule: 'RUBRIC', pending: 'NEEDS_RUBRIC_JUDGE' } }
}

/** 从选项里反查学生选的那个错误项绑定的错因 */
function errorTagsFromChoice(options: unknown, submitted: unknown): Array<{ code: string; note?: string }> {
  if (!Array.isArray(options)) return []
  const chosen = (options as Array<{ key?: unknown; errorTag?: unknown }>).find(
    (option) => norm(option.key) === norm(submitted),
  )
  return typeof chosen?.errorTag === 'string' ? [{ code: chosen.errorTag }] : []
}

export const gradeExecutor: NodeExecutor<GradeParams> = {
  type: 'GRADE',
  artifactKind: 'GRADING',
  promptVersion: 'grade-v1',
  inputs: {
    type: 'object',
    properties: {
      problems: { type: 'array', description: '上游题目集合（可选）' },
    },
    required: [],
  },
  outputs: {
    type: 'object',
    properties: {
      graded: { type: 'array' },
      correct: { type: 'number' },
      wrong: { type: 'number' },
      pendingRubric: { type: 'number' },
      skipped: { type: 'array' },
    },
    required: ['graded', 'correct', 'wrong', 'pendingRubric', 'skipped'],
  },

  async run(ctx) {
    const items = Array.isArray(ctx.params?.items) ? ctx.params.items.slice(0, MAX_GRADES) : []
    if (items.length === 0) {
      throw new Error(
        'grade 节点没有可批的作答。请在 params.items 里给出 [{ problemId, answer, methodId? }]；' +
          '界面上逐题作答走 POST /v1/problems/:id/attempts，不需要这个节点。',
      )
    }

    const graded: Array<{ problemId: string; attemptId: string; isCorrect: boolean | null; errorTags: unknown[] }> = []
    const skipped: Array<{ problemId: string; reason: string }> = []
    let correct = 0
    let wrong = 0
    let pendingRubric = 0
    let tokensIn = 0
    let tokensOut = 0
    const usageRecords: Array<({ provider: string; model: string } & TokenUsage)> = []

    for (const item of items) {
      const problem = await ctx.prisma.problem.findFirst({
        where: { id: item.problemId, canvasId: ctx.canvasId },
        select: {
          id: true,
          type: true,
          options: true,
          answer: true,
          judgeRule: true,
          judgeSpec: true,
          concepts: { select: { conceptId: true } },
        },
      })

      if (!problem) {
        // 跨画布的题不批：批了会让权限与统计都错位
        skipped.push({ problemId: item.problemId, reason: '题目不存在或不属于这张画布' })
        continue
      }

      const verdict = judgeDeterministic(problem.judgeRule, problem.judgeSpec, problem.answer, item.answer)

      let isCorrect = verdict.isCorrect
      let detail: Record<string, unknown> = verdict.detail
      let modelUsage: ({ provider: string; model: string } & TokenUsage) | null = null

      // RUBRIC 才调模型；确定性规则走本地
      if (isCorrect === null) {
        const rubric = problem.judgeSpec as { steps?: Array<{ order?: number; text?: string }> } | null
        const steps = Array.isArray(rubric?.steps) ? rubric.steps : []
        if (steps.length === 0) {
          // 没有评分步骤的 RUBRIC：判不了就走，不猜
          skipped.push({ problemId: item.problemId, reason: 'RUBRIC 题缺少 judgeSpec.steps，无法判分' })
          continue
        }

        const result = await ctx.llm.complete({
          taskType: 'check',
          messages: [
            { role: 'system', content: composeSystemPrompt(HARD_RULE_SUMMARY, ctx.skills, SYSTEM_PROMPT) },
            {
              role: 'user',
              content: [
                `题目：\n${(problem as unknown as { stemMd?: string }).stemMd ?? '(题干未载入)'}`,
                `参考答案：${JSON.stringify(problem.answer)}`,
                `评分步骤：\n${steps.map((step, index) => `${step.order ?? index + 1}. ${step.text ?? ''}`).join('\n')}`,
                `学生作答：${item.answer}`,
              ].join('\n\n'),
            },
          ],
          jsonSchema: outputSchema,
          user: ctx.user,
        })

        const data = result.data as { steps?: Array<{ order: number; pass: boolean; reason: string }>; isCorrect?: boolean } | undefined
        const reportedSteps = Array.isArray(data?.steps) ? data.steps : []
        // 步骤数对不上就不采信结论：模型可能只答了其中几步
        const covered = reportedSteps.length === steps.length
        isCorrect = covered && data?.isCorrect === true && reportedSteps.every((step) => step.pass === true)
        detail = {
          rule: 'RUBRIC',
          steps: reportedSteps,
          expectedSteps: steps.length,
          covered,
          ...(covered ? {} : { reason: 'STEPS_INCOMPLETE' }),
        }

        tokensIn += result.usage.tokensIn
        tokensOut += result.usage.tokensOut
        modelUsage = { provider: result.provider, model: result.modelVersion, ...result.usage }
      }

      const errorTags = isCorrect === false ? errorTagsFromChoice(problem.options, item.answer) : []

      const attempt = await ctx.prisma.attempt.create({
        data: {
          problemId: problem.id,
          userId: ctx.user.id,
          answer: item.answer as never,
          isCorrect,
          errorTags: errorTags as never,
          judgeDetail: detail as never,
          timeSpentSec: Math.max(0, Math.min(86_400, item.timeSpentSec ?? 0)),
        },
        select: { id: true },
      })

      await recordMethodApplication(ctx, {
        problemId: problem.id,
        attemptId: attempt.id,
        type: problem.type,
        conceptIds: problem.concepts.map((concept) => concept.conceptId),
        methodId: item.methodId,
        isCorrect: isCorrect === true,
        answered: isCorrect !== null,
      })

      if (modelUsage) usageRecords.push(modelUsage)
      if (isCorrect === true) correct += 1
      else if (isCorrect === false) wrong += 1
      else pendingRubric += 1

      graded.push({ problemId: problem.id, attemptId: attempt.id, isCorrect, errorTags })
    }

    return {
      outputs: {
        graded,
        correct,
        wrong,
        pendingRubric,
        // 跳过必须可见：静默少批几道，学生会以为全批过了
        skipped,
      },
      usage: { tokensIn, tokensOut, cachedTokens: usageRecords.reduce((sum, record) => sum + record.cachedTokens, 0),
        cacheUsageComplete: usageRecords.every(record => record.cacheUsageComplete !== false) },
      usageRecords,
    }
  },
}

/**
 * 写方法应用记录并刷新熟练度。
 *
 * 只有"真判了"（isCorrect 非 null）才写：待判的题不算一次方法应用，
 * 否则主观题会不断拉低/拉高熟练度，而学生其实还没被评。
 */
async function recordMethodApplication(
  ctx: NodeExecutorRunCtx<GradeParams>,
  input: {
    problemId: string
    attemptId: string
    type: string
    conceptIds: string[]
    methodId: string | undefined
    isCorrect: boolean
    answered: boolean
  },
): Promise<void> {
  if (!input.answered || !input.methodId) return

  const method = await ctx.prisma.method.findFirst({
    where: { id: input.methodId, canvasId: ctx.canvasId },
    select: { id: true },
  })
  if (!method) return

  const contextKey = buildContextKey(input.type, input.conceptIds)
  const seenInOtherContext = await ctx.prisma.methodApplication.findFirst({
    where: { methodId: method.id, contextKey: { not: contextKey }, userId: ctx.user.id },
    select: { id: true },
  })

  await ctx.prisma.methodApplication.create({
    data: {
      methodId: method.id,
      problemId: input.problemId,
      attemptId: input.attemptId,
      userId: ctx.user.id,
      isCorrect: input.isCorrect,
      isTransfer: Boolean(seenInOtherContext),
      isMisuse: !input.isCorrect,
      contextKey,
    },
  })

  await refreshMethodProficiency(ctx.prisma as never, method.id)
}
