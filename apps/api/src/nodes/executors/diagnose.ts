import type { JSONSchema } from '../../llm/types.ts'
import { composeSystemPrompt, HARD_RULE_SUMMARY } from '../skills.ts'
import type { NodeExecutor } from '../contract.ts'

/**
 * `diagnose` 执行器（M5）：错因归因。
 *
 * 输出 `ErrorTag` 集合 + 定位到具体步骤 + 补丁建议。
 *
 * 这里有一条容易做错的地方：错因必须**回连到概念或方法步骤**。
 * 只说"计算错误"没有教学价值 —— 学生知道要少算错，但不知道下次怎么避免。
 * 所以 schema 强制每个错因带 `stepIndex` 与 `patch`。
 */

const SYSTEM_PROMPT = `你是数学教学助手，分析学生的错误。

对每个错因给出：
- code：从给定类别里选（CONCEPT_GAP 概念没懂 / METHOD_MISMATCH 用错方法 /
  CONDITION_MISSED 漏条件 / COMPUTE_SLIP 算错 / READING_SLIP 看错题 / CHECK_OMITTED 没检查）
- stepIndex：错在第几步（从 0 开始；无法定位就给 null）
- note：具体错在哪
- patch：下次怎么避免（具体动作，不要"要细心"这种话）

只报真实存在的错因，不要凑数。如果看不出问题，返回空数组。`

const outputSchema: JSONSchema = {
  type: 'object',
  properties: {
    tags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          stepIndex: { type: ['integer', 'null'] },
          note: { type: 'string' },
          patch: { type: 'string' },
        },
        required: ['code', 'note', 'patch'],
        additionalProperties: false,
      },
    },
  },
  required: ['tags'],
  additionalProperties: false,
}

interface DiagnoseParams {
  /** 学生的作答原文 */
  answer: string
  /** 题目原文（可选，但给了能定位得更准） */
  problemText?: string
  /** 正确步骤（可选，来自上游 solve） */
  steps?: unknown
}

const VALID_CODES = new Set(['CONCEPT_GAP', 'METHOD_MISMATCH', 'CONDITION_MISSED', 'COMPUTE_SLIP', 'READING_SLIP', 'CHECK_OMITTED'])

export const diagnoseExecutor: NodeExecutor<DiagnoseParams> = {
  type: 'DIAGNOSE',
  artifactKind: 'ERROR_DIAGNOSIS',
  promptVersion: 'diagnose-v1',
  inputs: { type: 'object', properties: { steps: { type: 'array' } }, required: [] },
  outputs: { type: 'object', properties: { tags: { type: 'array' } }, required: ['tags'] },

  async run(ctx) {
    const answer = ctx.params?.answer?.trim()
    if (!answer) throw new Error('diagnose 节点缺少 params.answer（学生作答）')

    type Step = { cue?: string; why?: string; action?: string }
    const upstreamSteps = (ctx.inputs.steps as Step[] | undefined) ?? (ctx.params.steps as Step[] | undefined)
    const parts = [
      ctx.params.problemText ? `题目：\n${ctx.params.problemText}` : '',
      upstreamSteps && Array.isArray(upstreamSteps) && upstreamSteps.length > 0
        ? `正确步骤：\n${upstreamSteps.map((step, index) => `${index}. ${step.action ?? ''}（依据：${step.why ?? ''}）`).join('\n')}`
        : '',
      `学生作答：\n${answer}`,
    ].filter(Boolean)

    const result = await ctx.llm.complete({
      taskType: 'method',
      messages: [
        { role: 'system', content: composeSystemPrompt(HARD_RULE_SUMMARY, ctx.skills, SYSTEM_PROMPT) },
        { role: 'user', content: parts.join('\n\n') },
      ],
      jsonSchema: outputSchema,
      user: ctx.user,
    })

    const raw = (result.data as { tags?: Array<{ code?: string; stepIndex?: number | null; note?: string; patch?: string }> }).tags ?? []

    // 过滤未知 code：写进库的错因必须是词典里的，否则统计页会出现无法解释的项
    const dropped = raw.filter((tag) => !tag?.code || !VALID_CODES.has(tag.code)).map((tag) => tag?.code ?? '(空)')
    const tags = raw
      .filter((tag): tag is { code: string; stepIndex?: number | null; note: string; patch: string } => typeof tag?.code === 'string' && VALID_CODES.has(tag.code) && typeof tag.note === 'string' && typeof tag.patch === 'string')
      .map((tag) => ({
        code: tag.code,
        stepIndex: typeof tag.stepIndex === 'number' ? tag.stepIndex : null,
        note: tag.note,
        patch: tag.patch,
      }))

    return {
      outputs: { tags, droppedCodes: dropped },
      usage: result.usage,
      usageRecords: [{ provider: result.provider, model: result.modelVersion, ...result.usage }],
    }
  },
}
