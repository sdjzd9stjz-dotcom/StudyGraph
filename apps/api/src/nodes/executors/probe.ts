import type { JSONSchema } from '../../llm/types.ts'
import { composeSystemPrompt, HARD_RULE_SUMMARY } from '../skills.ts'
import type { NodeExecutor } from '../contract.ts'

/**
 * `probe` 执行器（M5）：题型与考点识别。
 *
 * 输入是题目/例题文本，输出题型标签、涉及概念、**隐含条件**与**易漏条件**。
 * 后两项才是这个节点存在的理由：学生做错多半不是不会算，而是没看见条件。
 *
 * 不产出知识卡、不改任何状态：probe 只给下游 `method` / `solve` 提供结构化输入。
 */

const SYSTEM_PROMPT = `你是数学教学助手。读一道题，判断它考什么。

要求：
- 题型标签用简短短语，不要长句
- 涉及概念只列题目真正用到的，不要为了全面而堆
- 隐含条件：题目没明说但解题必须用到的（如"定义域"隐含 x≠0）
- 易漏条件：学生最常忽略、导致答案不完整或错误的条件
- 如果题目信息不足无法判断，就如实说明，不要猜`

const outputSchema: JSONSchema = {
  type: 'object',
  properties: {
    problemType: { type: 'string' },
    concepts: { type: 'array', items: { type: 'string' } },
    hiddenConditions: { type: 'array', items: { type: 'string' } },
    easilyMissed: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['problemType', 'concepts', 'hiddenConditions', 'easilyMissed'],
  additionalProperties: false,
}

interface ProbeParams {
  /** 题目原文；由调用方（或上传的 TEXT 源）给出 */
  text: string
}

export const probeExecutor: NodeExecutor<ProbeParams> = {
  type: 'PROBE',
  artifactKind: 'PROBE_PROFILE',
  promptVersion: 'probe-v1',
  inputs: { type: 'object', properties: {}, required: [] },
  outputs: { type: 'object', properties: { analysis: { type: 'object' } }, required: ['analysis'] },

  async run(ctx) {
    const text = ctx.params?.text?.trim()
    if (!text) throw new Error('probe 节点缺少 params.text（题目原文）')

    const result = await ctx.llm.complete({
      taskType: 'probe',
      messages: [
        { role: 'system', content: composeSystemPrompt(HARD_RULE_SUMMARY, ctx.skills, SYSTEM_PROMPT) },
        { role: 'user', content: text },
      ],
      jsonSchema: outputSchema,
      user: ctx.user,
    })

    const data = result.data as Record<string, unknown>
    return {
      outputs: { analysis: data },
      usage: result.usage,
      usageRecords: [{ provider: result.provider, model: result.modelVersion, ...result.usage }],
    }
  },
}
