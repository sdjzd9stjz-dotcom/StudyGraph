import type { JSONSchema } from '../../llm/types.ts'
import { composeSystemPrompt, HARD_RULE_SUMMARY } from '../skills.ts'
import type { NodeExecutor } from '../contract.ts'

/**
 * `distractor` 执行器（M6）：生成**有诊断性**的错误选项。
 *
 * 硬约束：干扰项必须诊断错因。
 * 这是本项目与普通题库最大的区别 —— 普通题库的错误选项是"看起来像的随机数"，
 * 学生选错了只知道"错了"；这里的每个干扰项都对应一种**具体的思维错误**，
 * 选哪个选项就暴露哪类误解。
 *
 * 所以 schema 强制每个选项带 `errorTag`（取自六类错因），并且——关键——
 * 不允许出现"凑数选项"：一个选项说不出学生为什么会被它吸引，就不要它。
 */

const VALID_TAGS = ['CONCEPT_GAP', 'METHOD_MISMATCH', 'CONDITION_MISSED', 'COMPUTE_SLIP', 'READING_SLIP', 'CHECK_OMITTED']

const SYSTEM_PROMPT = `你是数学命题助手。为一道选择题生成干扰项。

每个干扰项必须绑定一个错因，说明"学生为什么会选它"：
- CONCEPT_GAP      概念没懂（用错了某个定义或性质）
- METHOD_MISMATCH  用错方法（套了一个不适用这类题的方法）
- CONDITION_MISSED 漏条件（忽略定义域、边界、符号等）
- COMPUTE_SLIP     算错（思路对，运算出错）
- READING_SLIP     看错题（把条件或问题理解错了）
- CHECK_OMITTED    没检查（答案不完整、漏解）

硬性要求：
- **不要凑数**。说不出学生为什么会被吸引，就不要出这个选项
- 干扰项必须"看起来合理"：要么是常见错法，要么是漏条件的结果
- 不要出明显荒谬的选项（那测不出任何东西）`

const outputSchema: JSONSchema = {
  type: 'object',
  properties: {
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          text: { type: 'string' },
          errorTag: { type: 'string' },
          why: { type: 'string', description: '学生为什么会选它' },
        },
        required: ['key', 'text', 'errorTag', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['options'],
  additionalProperties: false,
}

interface DistractorParams {
  stem: string
  /** 正确答案 */
  answer: string
  /** 要几个干扰项 */
  count?: number
}

export const distractorExecutor: NodeExecutor<DistractorParams> = {
  type: 'DISTRACTOR',
  artifactKind: 'DISTRACTOR_SET',
  promptVersion: 'distractor-v1',
  inputs: { type: 'object', properties: { variants: { type: 'array' } }, required: [] },
  outputs: { type: 'object', properties: { options: { type: 'array' } }, required: ['options'] },

  async run(ctx) {
    const stem = ctx.params?.stem?.trim()
    const answer = ctx.params?.answer?.trim()
    if (!stem || !answer) throw new Error('distractor 节点缺少 params.stem / params.answer')

    const count = Math.min(5, Math.max(1, ctx.params.count ?? 3))

    const result = await ctx.llm.complete({
      taskType: 'quiz',
      messages: [
        { role: 'system', content: composeSystemPrompt(HARD_RULE_SUMMARY, ctx.skills, SYSTEM_PROMPT) },
        { role: 'user', content: `题目：\n${stem}\n\n正确答案：${answer}\n\n请生成 ${count} 个干扰项。` },
      ],
      jsonSchema: outputSchema,
      user: ctx.user,
    })

    const raw = (result.data as { options?: Array<Record<string, unknown>> }).options ?? []
    const dropped: string[] = []

    const distractors = []
    for (const item of raw) {
      const tag = typeof item.errorTag === 'string' ? item.errorTag : ''
      // 错因不在六类里 → 丢弃：写进库的错因必须能对应到统计维度
      if (!VALID_TAGS.includes(tag)) {
        dropped.push(`${String(item.text ?? '')}(${tag || '无错因'})`)
        continue
      }
      // 说不出"为什么会被吸引" → 丢弃：那种选项测不出任何东西
      if (typeof item.why !== 'string' || item.why.trim().length < 4) {
        dropped.push(`${String(item.text ?? '')}(无诊断说明)`)
        continue
      }
      distractors.push({
        key: typeof item.key === 'string' ? item.key : String.fromCharCode(65 + distractors.length),
        text: String(item.text ?? ''),
        errorTag: tag,
        why: item.why.trim(),
      })
    }

    return {
      outputs: {
        // 正确项 + 干扰项组成完整选项集
        options: [{ key: 'A', text: answer, errorTag: null, why: null }, ...distractors],
        distractors: distractors.length,
        dropped,
      },
      usage: result.usage,
      usageRecords: [{ provider: result.provider, model: result.modelVersion, ...result.usage }],
    }
  },
}
