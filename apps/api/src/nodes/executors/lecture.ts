import type { JSONSchema } from '../../llm/types.ts'
import type { UpstreamContextEntry } from '../execute.ts'
import { composeSystemPrompt, HARD_RULE_SUMMARY } from '../skills.ts'
import type { NodeExecutor } from '../contract.ts'
import { nodeInputMissing } from '../../lib/errors.ts'

/**
 * `lecture` 执行器：导出讲义（用户 2026-11-21 要求）。
 *
 * 它接受**多个节点的产出与对话**（端口是联合入口），归纳成一份可打印的讲义。
 * 这是整张知识网络的"收口"：学生在各个节点里问过什么、得到什么，
 * 最后在这里变成一份能带走的东西。
 *
 * 讲义正文用 Markdown 生成 —— 渲染成 PDF 由客户端用 Chromium 完成
 * （中文排版不需要额外字体），服务端只负责内容。
 */

const SYSTEM_PROMPT = [
  '你是课程讲义编辑。把给定的多个节点的产出与对话整理成一份**讲义**。',
  '数学公式用 $...$ 或 $$...$$ 包裹，逐字引文保留原样。',
  '规则：',
  '1. 只使用材料里的内容，不补充材料之外的知识。',
  '2. markdown 用二级标题（##）分节，建议结构：概念与定义 → 核心要点 → 例题与解法 → 易错点 → 复习建议；材料缺少的部分直接略过，不要硬凑。',
  '3. 对话里学生问过的疑问要体现出来（"常见疑问"或并入相关小节），这是讲义最有价值的部分。',
  '4. outline 是章节标题数组（不带 ##），与 markdown 的二级标题一一对应。',
  '5. 不要写"根据提供的材料"这类元话术，直接写内容。',
].join('\n')

const outputSchema: JSONSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    outline: { type: 'array', items: { type: 'string' } },
    markdown: { type: 'string' },
  },
  required: ['title', 'outline', 'markdown'],
  additionalProperties: false,
}

/** 材料预算：讲义节点可以吃很多上游，但一次调用能读的就这么多 */
const CONTEXT_BUDGET = 24_000

export const lectureExecutor: NodeExecutor = {
  type: 'LECTURE',
  artifactKind: 'LECTURE_DOC',
  promptVersion: 'lecture-v1',
  inputs: {
    type: 'object',
    properties: {
      upstreamContext: { type: 'array', description: '所有上游节点的产物摘要与对话' },
    },
    required: [],
  },
  outputs: {
    type: 'object',
    properties: { title: { type: 'string' }, outline: { type: 'array' }, markdown: { type: 'string' } },
    required: ['title', 'outline', 'markdown'],
  },

  async run(ctx) {
    const context = (ctx.inputs.upstreamContext as UpstreamContextEntry[] | undefined) ?? []
    if (context.length === 0) {
      throw nodeInputMissing('导出讲义需要至少一个上游节点（带上它的产出或对话）')
    }

    const material: string[] = []
    let budget = CONTEXT_BUDGET
    let dropped = 0

    for (const entry of context) {
      const block =
        `## 节点：${entry.title}（${entry.type}）\n` +
        (entry.summary ? `产出：\n${entry.summary}\n` : '') +
        (entry.conversation ? `对话：\n${entry.conversation}\n` : '')
      if (budget <= 0) {
        dropped += 1
        continue
      }
      const clipped = block.slice(0, budget)
      budget -= clipped.length
      material.push(clipped)
    }

    const result = await ctx.llm.complete({
      taskType: 'method',
      messages: [
        { role: 'system', content: composeSystemPrompt(HARD_RULE_SUMMARY, ctx.skills, SYSTEM_PROMPT) },
        { role: 'user', content: material.join('\n\n') },
      ],
      jsonSchema: outputSchema,
      maxTokens: 8192,
      user: ctx.user,
    })

    const data = result.data as { title?: unknown; outline?: unknown; markdown?: unknown } | undefined
    const markdown = typeof data?.markdown === 'string' ? data.markdown.trim() : ''
    if (markdown.length === 0) throw new Error('模型没有返回讲义正文（markdown 为空）')

    const outline = Array.isArray(data?.outline)
      ? data.outline.filter((heading): heading is string => typeof heading === 'string').slice(0, 20)
      : []

    return {
      outputs: {
        // 节点参数里填了标题就以它为准：学生显式命名的东西，不该被模型改写
        title:
          typeof (ctx.params as { title?: unknown } | null)?.title === 'string' &&
          ((ctx.params as { title?: string }).title ?? '').trim().length > 0
            ? ((ctx.params as { title?: string }).title ?? '').trim()
            : typeof data?.title === 'string' && data.title.trim().length > 0
              ? data.title.trim()
              : '课程讲义',
        outline,
        markdown,
        dropped,
        sources: context.map((entry) => ({ nodeId: entry.nodeId, title: entry.title, type: entry.type })),
      },
      usage: result.usage,
      usageRecords: [{ provider: result.provider, model: result.modelVersion, ...result.usage }],
    }
  },
}
