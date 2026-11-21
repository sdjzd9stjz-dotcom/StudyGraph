import type { JSONSchema } from '../../llm/types.ts'
import { composeSystemPrompt, HARD_RULE_SUMMARY } from '../skills.ts'
import type { NodeExecutor } from '../contract.ts'

/**
 * `check` 执行器（M6）：出题后三检。
 *
 * 三检（规格「出题必须过三检」）：
 *   1. 可解性 —— 条件够不够，有没有唯一答案
 *   2. 答案正确 —— 自己解一遍，与给定答案比对
 *   3. 干扰项有效 —— 每个错误选项是否对应真实错因、是否有明显荒谬项
 *
 * 关键设计：**三检不过就不入库**。不是"标记一下继续用"。
 * 一道错题会被学生反复练，代价远大于少出一道。
 */

const CHECK_ITEMS = ['solvable', 'answerCorrect', 'distractorsValid'] as const
type CheckItem = (typeof CHECK_ITEMS)[number]

const SYSTEM_PROMPT = `你是数学题的质检员。对给定题目做三项检查：

1. **可解性**：条件是否充分？是否存在唯一答案？有没有歧义？
2. **答案正确**：自己解一遍，与给出的答案比对。如果答案错了，直接判失败。
3. **干扰项有效**：每个错误选项是否对应一个真实错因？有没有明显荒谬的凑数选项？

对每一项给出 pass / fail 和一句理由。任何一项 fail，整道题就不通过。`

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

interface CheckParams {
  stem: string
  answer: string
  options?: Array<{ key: string; text: string; errorTag?: string | null }>
}

export const checkExecutor: NodeExecutor<CheckParams> = {
  type: 'CHECK',
  artifactKind: 'CHECK_VERDICT',
  promptVersion: 'check-v1',
  inputs: { type: 'object', properties: { options: { type: 'array' } }, required: [] },
  outputs: { type: 'object', properties: { passed: { type: 'boolean' }, result: { type: 'object' } }, required: ['passed', 'result'] },

  async run(ctx) {
    const stem = ctx.params?.stem?.trim()
    const answer = ctx.params?.answer?.trim()
    if (!stem || !answer) throw new Error('check 节点缺少 params.stem / params.answer')

    const options = ctx.params.options ?? (ctx.inputs.options as CheckParams['options']) ?? []

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
      outputs: {
        passed,
        result: { checks, failed: checks.filter((check) => !check.pass).map((check) => check.item) },
      },
      usage: result.usage,
      usageRecords: [{ provider: result.provider, model: result.modelVersion, ...result.usage }],
    }
  },
}
