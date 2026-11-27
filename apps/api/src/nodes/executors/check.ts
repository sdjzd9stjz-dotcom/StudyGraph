import type { JSONSchema } from '../../llm/types.ts'
import { composeSystemPrompt, HARD_RULE_SUMMARY } from '../skills.ts'
import { ZERO_USAGE } from '../contract.ts'
import type { NodeExecutor, NodeExecutorRunCtx, QuizQuestionRef } from '../contract.ts'
import { AppError, nodeInputMissing } from '../../lib/errors.ts'

/**
 * `check` 执行器（M6）：出题后三检。
 *
 * 三检（规格「出题必须过三检」）：
 *   1. 可解性 —— 条件够不够，有没有唯一答案
 *   2. 答案正确 —— 自己解一遍，与给定答案比对
 *   3. 干扰项有效 —— 每个错误选项是否对应真实错因、是否有明显荒谬项
 *
 * 题库保留被驳回的题及理由，便于定位出题问题。只有三项全部通过才能组卷。
 * 一道错题会被学生反复练，代价远大于少出一道。
 */

const CHECK_ITEMS = ['solvable', 'answerCorrect', 'distractorsValid'] as const
type CheckItem = (typeof CHECK_ITEMS)[number]

const SYSTEM_PROMPT = `你是数学题的质检员。对给定题目做三项检查：

1. **可解性**：条件是否充分？是否存在唯一答案？有没有歧义？
2. **答案正确**：自己解一遍，与给出的答案比对。如果答案错了，直接判失败。
3. **干扰项有效**：每个错误选项是否对应一个真实错因？有没有明显荒谬的凑数选项？

题型本身无选项时，干扰项一栏注明“不适用”并判通过。对每一项给出 pass / fail 和一句理由。任何一项 fail，整道题就不通过。`

const outputSchema: JSONSchema = {
  type: 'object',
  properties: {
    solvable: { type: 'object', properties: { pass: { type: 'boolean' }, reason: { type: 'string' } }, required: ['pass', 'reason'], additionalProperties: false },
    answerCorrect: { type: 'object', properties: { pass: { type: 'boolean' }, reason: { type: 'string' } }, required: ['pass', 'reason'], additionalProperties: false },
    distractorsValid: { type: 'object', properties: { pass: { type: 'boolean' }, reason: { type: 'string' } }, required: ['pass', 'reason'], additionalProperties: false },
  },
  required: ['solvable', 'answerCorrect', 'distractorsValid'],
  additionalProperties: false,
}

export interface CheckParams {
  stem?: string
  answer?: string
  options?: Array<{ key: string; text: string; errorTag?: string | null }>
}

export const checkExecutor: NodeExecutor<CheckParams> = {
  type: 'CHECK',
  artifactKind: 'CHECK_VERDICT',
  promptVersion: 'check-v2',
  inputs: { type: 'object', properties: { options: { type: 'array' } }, required: [] },
  outputs: { type: 'object', properties: { passed: { type: 'boolean' }, result: { type: 'object' } }, required: ['passed', 'result'] },

  async run(ctx) {
    const stem = ctx.params?.stem?.trim()
    const answer = ctx.params?.answer?.trim()
    if (!stem && !answer && ctx.quizBatch?.length) {
      return checkStoredQuestions(ctx, ctx.quizBatch)
    }
    if (!stem || !answer) throw nodeInputMissing('请连接已经出题的节点，或填写题干和给定答案作单题检查')

    const options = ctx.params.options ?? (ctx.inputs.options as CheckParams['options']) ?? []

    const { verdict, record, usage } = await judge(ctx, stem, answer, options)
    return { outputs: { passed: verdict.passed, result: verdict }, usage, usageRecords: [record] }
  },
}

async function judge(ctx: NodeExecutorRunCtx<CheckParams>, stem: string, answer: string, options: NonNullable<CheckParams['options']>) {
  const result = await ctx.llm.complete({
    taskType: 'check',
    messages: [
      { role: 'system', content: composeSystemPrompt(HARD_RULE_SUMMARY, ctx.skills, SYSTEM_PROMPT) },
      {
        role: 'user',
        content: [
          `题目：\n${stem}`,
          `给定答案：${answer}`,
          options.length > 0
            ? `选项：\n${options.map((option) => `${option.key}. ${option.text}${option.errorTag ? `（错因 ${option.errorTag}）` : ''}`).join('\n')}`
            : '(无选项)',
        ].join('\n\n'),
      },
    ],
    jsonSchema: outputSchema,
    user: ctx.user,
  })

  const data = result.data as Record<CheckItem, { pass: boolean; reason: string }> | undefined
  const checks: Array<{ item: CheckItem; pass: boolean; reason: string }> = []
  for (const item of CHECK_ITEMS) {
    const entry = data?.[item]
    checks.push({
      item,
      // 缺项按失败处理：没检就等于没过
      pass: entry?.pass === true,
      reason: typeof entry?.reason === 'string' ? entry.reason : '质检未返回该项结果',
    })
  }

  const passed = checks.every((check) => check.pass)
  return {
    verdict: { passed, checks, failed: checks.filter(check => !check.pass).map(check => check.item) },
    record: { provider: result.provider, model: result.modelVersion, ...result.usage },
    usage: result.usage,
  }
}

async function checkStoredQuestions(ctx: NodeExecutorRunCtx<CheckParams>, refs: QuizQuestionRef[]) {
  const questions = await ctx.prisma.problem.findMany({
    where: { canvasId: ctx.canvasId, OR: refs },
    select: { id: true, stemMd: true, answer: true, options: true, status: true, updatedAt: true, _count: { select: { citations: true } } },
    orderBy: { id: 'asc' },
  })
  if (questions.length !== new Set(refs.map(ref => ref.id)).size) {
    throw nodeInputMissing('上游这批题已有变更，请重新出题后运行质量闸门')
  }
  const pending = questions.filter(question => question.status === 'PENDING')
  if (pending.some(question => question._count.citations === 0)) {
    throw nodeInputMissing('这批待检题中有题目缺少原文引用，请补全来源并重新出题')
  }

  const updates: { id: string; updatedAt: Date; verdict: Awaited<ReturnType<typeof judge>>['verdict'] }[] = []
  const records = []
  const usage = { ...ZERO_USAGE }
  for (const question of pending) {
    const answer = typeof question.answer === 'string' ? question.answer : JSON.stringify(question.answer)
    const options = Array.isArray(question.options) ? question.options as NonNullable<CheckParams['options']> : []
    const { verdict, record } = await judge(ctx, question.stemMd, answer, options)
    updates.push({ id: question.id, updatedAt: question.updatedAt, verdict })
    records.push(record)
    usage.tokensIn += record.tokensIn
    usage.tokensOut += record.tokensOut
    usage.cachedTokens += record.cachedTokens
  }

  // 模型调用结束后再开短事务，防止耗时判断覆盖期间的编辑或其他质检结果。
  if (updates.length > 0) {
    await ctx.prisma.$transaction(async tx => {
      const now = new Date()
      for (const { id, updatedAt, verdict } of updates) {
        const changed = await tx.problem.updateMany({
          where: { id, canvasId: ctx.canvasId, status: 'PENDING', updatedAt },
          data: {
            status: verdict.passed ? 'VERIFIED' : 'REJECTED',
            checkResult: verdict,
            verifiedAt: verdict.passed ? now : null,
            rejectedAt: verdict.passed ? null : now,
            rejectReason: verdict.passed ? null : verdict.checks.filter(check => !check.pass)
              .map(check => check.reason.trim() || check.item).join('；'),
          },
        })
        if (!changed.count) throw new AppError(409, 'PROBLEM_CHECK_CONFLICT', '质检期间题目已更新，请重新运行质量闸门')
      }
    })
  }
  const verified = questions.filter(question => question.status === 'VERIFIED').length + updates.filter(update => update.verdict.passed).length
  const rejected = questions.length - verified
  return { outputs: { passed: rejected === 0, result: { verified, rejected } }, usage, usageRecords: records }
}
