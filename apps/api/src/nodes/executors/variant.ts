import type { JSONSchema } from '../../llm/types.ts'
import { composeSystemPrompt, HARD_RULE_SUMMARY } from '../skills.ts'
import type { NodeExecutor } from '../contract.ts'
import { nodeInputMissing } from '../../lib/errors.ts'

/**
 * `variant` 执行器（M6）：沿六个维度生成变式，**保留原题的方法结构**。
 *
 * 六维（规格「变式六维参数面板」）：
 *   表征形式 / 数值规模 / 情境包装 / 提问方向 / 条件增减 / 综合程度
 *
 * 最关键的一条：变式必须**保留方法结构**。换个数字不叫变式，那只是换皮；
 * 真正的变式考的是"同一个方法在哪些地方还能用"。
 */

export const VARIANT_AXES = ['representation', 'magnitude', 'context', 'direction', 'conditionSet', 'complexity'] as const
export type VariantAxisName = (typeof VARIANT_AXES)[number]

const AXIS_LABEL: Record<VariantAxisName, string> = {
  representation: '表征形式（图/表/文字/符号互换）',
  magnitude: '数值规模（保持结构，改数量级）',
  context: '情境包装（换背景故事）',
  direction: '提问方向（正问/反问/求条件）',
  conditionSet: '条件增减（加一个条件 / 去掉一个条件）',
  complexity: '综合程度（并进另一个方法）',
}

const SYSTEM_PROMPT = `你是数学命题助手。给定一道原题，沿指定维度生成变式题。

硬性要求：
- **必须保留原题的方法结构**：解变式题要用到的核心方法、步骤顺序、关键判断，
  应当与原题一致。只换数字不叫变式。
- 每道变式给出：题干、答案、所用方法的一句话说明、它改动了哪个维度
- 题目必须自洽可解，不要出需要原题背景才能做的题`

const outputSchema: JSONSchema = {
  type: 'object',
  properties: {
    variants: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          axis: { type: 'string', description: `六维之一：${VARIANT_AXES.join('/')}` },
          stem: { type: 'string' },
          answer: { type: 'string' },
          methodNote: { type: 'string', description: '为什么它和方法结构一致' },
          difficulty: { type: 'integer' },
        },
        required: ['axis', 'stem', 'answer', 'methodNote'],
        additionalProperties: false,
      },
    },
  },
  required: ['variants'],
  additionalProperties: false,
}

interface VariantParams {
  /** 原题题干 */
  stem: string
  /** 只在这些维度上出（可选，默认全六维） */
  axes?: string[]
  count?: number
}

export const variantExecutor: NodeExecutor<VariantParams> = {
  type: 'VARIANT',
  artifactKind: 'VARIANT_SET',
  promptVersion: 'variant-v1',
  inputs: { type: 'object', properties: { method: { type: 'object' } }, required: [] },
  outputs: { type: 'object', properties: { variants: { type: 'array' } }, required: ['variants'] },

  async run(ctx) {
    const stem = ctx.params?.stem?.trim()
    if (!stem) throw nodeInputMissing('variant 节点缺少 params.stem（原题题干）')

    const axes = (ctx.params.axes?.filter((axis): axis is VariantAxisName => (VARIANT_AXES as readonly string[]).includes(axis)) ?? [...VARIANT_AXES])
    const count = Math.min(12, Math.max(1, ctx.params.count ?? axes.length))

    const method = ctx.inputs.method as { name?: string; steps?: unknown } | undefined
    const context = [
      method?.name ? `原题所用方法：${method.name}` : '',
      `请生成 ${count} 道变式，覆盖这些维度：${axes.map((axis) => AXIS_LABEL[axis]).join('；')}`,
      `原题：\n${stem}`,
    ].filter(Boolean).join('\n\n')

    const result = await ctx.llm.complete({
      taskType: 'variant',
      messages: [
        { role: 'system', content: composeSystemPrompt(HARD_RULE_SUMMARY, ctx.skills, SYSTEM_PROMPT) },
        { role: 'user', content: context },
      ],
      jsonSchema: outputSchema,
      user: ctx.user,
    })

    const raw = (result.data as { variants?: Array<Record<string, unknown>> }).variants ?? []
    const variants = raw
      .filter((item) => typeof item.stem === 'string' && typeof item.answer === 'string')
      .map((item) => ({
        axis: typeof item.axis === 'string' && (VARIANT_AXES as readonly string[]).includes(item.axis) ? item.axis : 'complexity',
        stem: String(item.stem),
        answer: String(item.answer),
        methodNote: typeof item.methodNote === 'string' ? item.methodNote : '',
        difficulty: typeof item.difficulty === 'number' ? Math.min(5, Math.max(1, Math.round(item.difficulty))) : 2,
      }))

    return {
      outputs: { variants, requested: count, axes },
      usage: result.usage,
      usageRecords: [{ provider: result.provider, model: result.modelVersion, ...result.usage }],
    }
  },
}
