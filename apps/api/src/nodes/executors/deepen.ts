import type { JSONSchema } from '../../llm/types.ts'
import type { UpstreamContextEntry } from '../execute.ts'
import { composeSystemPrompt, HARD_RULE_SUMMARY } from '../skills.ts'
import type { NodeExecutor } from '../contract.ts'
import { nodeInputMissing } from '../../lib/errors.ts'

/**
 * `deepen` 执行器：深入理解（用户 2026-11-21 要求）。
 *
 * 它**只吃知识卡与题目**（端口在 contracts 里写死，连别的类型连不上），
 * 产出的是「核心观点」而不是又一份摘要 —— 让画布从"一堆产物"变成"一张知识图"。
 *
 * 关键约束：观点必须能回指到给定的卡片或题目。模型很喜欢写"综上所述"式的大话，
 * 所以 schema 里 evidence 是必填，且提示词明确要求点名出处。
 */

const SYSTEM_PROMPT = [
  '你是学习教练，负责把知识点与题目收敛成**核心观点**。',
  '规则：',
  '1. 只用材料里出现的知识卡与题目，不许引入材料之外的知识。',
  '2. 每条观点必须能由某张卡或某道题支撑，evidence 里点名是哪一张（写名称）。',
  '3. 观点之间不要重复；宁少勿滥，3–8 条。',
  '4. insight 用一两句话讲清"为什么重要 / 怎么用"，不要复述定义。',
  '5. 材料不够支撑观点时，宁可少给，并在 summary 里说明缺什么。',
].join('\n')

const outputSchema: JSONSchema = {
  type: 'object',
  properties: {
    points: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          insight: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['title', 'insight', 'evidence'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
  },
  required: ['points', 'summary'],
  additionalProperties: false,
}

/** 上下文总预算：再多模型也读不完，还会挤掉系统提示 */
const CONTEXT_BUDGET = 12_000

export const deepenExecutor: NodeExecutor = {
  type: 'DEEPEN',
  artifactKind: 'DEEP_INSIGHT',
  promptVersion: 'deepen-v1',
  inputs: {
    type: 'object',
    properties: {
      cards: { type: 'object', description: '上游知识卡（可选）' },
      created: { type: 'array', description: '上游题目（可选）' },
      upstreamContext: { type: 'array', description: '上游节点的产物摘要与对话' },
    },
    required: [],
  },
  outputs: {
    type: 'object',
    properties: { points: { type: 'array' }, summary: { type: 'string' } },
    required: ['points', 'summary'],
  },

  async run(ctx) {
    const context = (ctx.inputs.upstreamContext as UpstreamContextEntry[] | undefined) ?? []
    const cards = ctx.inputs.cards as { cards?: unknown[] } | undefined
    const problems = Array.isArray(ctx.inputs.created) ? (ctx.inputs.created as unknown[]) : []

    const material: string[] = []
    let budget = CONTEXT_BUDGET

    const push = (block: string) => {
      if (budget <= 0) return
      const clipped = block.slice(0, budget)
      budget -= clipped.length
      material.push(clipped)
    }

    for (const entry of context) {
      push(
        `## ${entry.title}（${entry.type}）\n` +
          (entry.summary ? `产出摘要：\n${entry.summary}\n` : '') +
          (entry.conversation ? `对话：\n${entry.conversation}\n` : ''),
      )
    }
    if (Array.isArray(cards?.cards) && cards.cards.length > 0) {
      push(`## 知识卡明细\n${JSON.stringify(cards.cards).slice(0, budget)}`)
    }
    if (problems.length > 0) {
      push(`## 题目明细\n${JSON.stringify(problems).slice(0, budget)}`)
    }

    if (material.length === 0) {
      throw nodeInputMissing('深入理解需要上游的知识卡或题目（或它们的对话）作为材料')
    }

    const result = await ctx.llm.complete({
      taskType: 'method',
      messages: [
        { role: 'system', content: composeSystemPrompt(HARD_RULE_SUMMARY, ctx.skills, SYSTEM_PROMPT) },
        { role: 'user', content: material.join('\n\n') },
      ],
      jsonSchema: outputSchema,
      maxTokens: 4096,
      user: ctx.user,
    })

    const data = result.data as
      | { points?: Array<{ title?: unknown; insight?: unknown; evidence?: unknown }>; summary?: unknown }
      | undefined

    const points = (data?.points ?? [])
      .filter((point): point is { title: string; insight: string; evidence: string } =>
        typeof point?.title === 'string' && typeof point?.insight === 'string' && typeof point?.evidence === 'string',
      )
      .slice(0, 8)
      .map((point) => ({ title: point.title.trim(), insight: point.insight.trim(), evidence: point.evidence.trim() }))

    if (points.length === 0) {
      throw new Error('模型没有给出可用的核心观点（points 为空或字段缺失）')
    }

    return {
      outputs: {
        points,
        summary: typeof data?.summary === 'string' ? data.summary.trim() : '',
        sources: context.map((entry) => ({ nodeId: entry.nodeId, title: entry.title, type: entry.type })),
      },
      usage: result.usage,
      usageRecords: [{ provider: result.provider, model: result.modelVersion, ...result.usage }],
    }
  },
}
