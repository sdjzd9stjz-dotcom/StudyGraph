import { chunkSetSchema } from '../../../../../packages/contracts/src/index.ts'
import type { ChunkSet, SourceDoc } from '../../../../../packages/contracts/src/index.ts'
import type { NodeExecutor } from '../contract.ts'
import { ZERO_USAGE } from '../contract.ts'
import { nodeInputMissing } from '../../lib/errors.ts'

interface ChunkParams {
  /** 单个切片的目标字符数；超过就按页切开（M2 一页一片，不做跨页合并） */
  maxChars?: number
}

/**
 * `chunk` 节点：原文 → 语义切片。
 *
 * M2 的实现是**确定性**的（不调模型）：一个非空页/幻灯片 = 一个切片，
 * 切片的 `spanIds` 就是该页的 span。这样做的好处是：
 *
 * - 切片与原文的对应关系是 1:1 可验证的，没有"模型切歪了"的可疑空间
 * - 之后把切片策略换成模型/规则混合时，指纹会把旧产物自然淘汰
 *
 * 空文本页没有 span，因此也不会产出切片（不凭空造内容）。
 */
export const chunkExecutor: NodeExecutor<ChunkParams> = {
  type: 'CHUNK',
  artifactKind: 'CHUNKS',
  promptVersion: 'no-prompt',
  inputs: { type: 'object', properties: { sourceDoc: { type: 'object' } }, required: ['sourceDoc'] },
  outputs: { type: 'object', properties: { chunkSet: { type: 'object' } }, required: ['chunkSet'] },

  async run(ctx) {
    const sourceDoc = ctx.inputs.sourceDoc as SourceDoc | undefined
    if (!sourceDoc?.sourceId) throw nodeInputMissing('chunk 节点缺少上游 sourceDoc')

    const maxChars = ctx.params.maxChars ?? 800
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('maxChars 必须是正整数')

    const spans = await ctx.prisma.span.findMany({
      where: { sourceId: sourceDoc.sourceId },
      orderBy: [{ page: 'asc' }, { region: 'asc' }],
      select: { id: true, page: true, text: true },
    })

    if (spans.length === 0) {
      throw new Error(`source ${sourceDoc.sourceId} 没有任何 span，无法切片`)
    }

    // SG-SUP-008 §3：**切分而不是截断**。
    // maxChars 是单个 chunk 的上限，不是整页的上限；超长页切成多片，
    // 所有片拼起来必须等于该页 span 的完整 text。
    const chunks: Array<{
      id: string
      order: number
      text: string
      spanIds: string[]
      pageStart: number
      pageEnd: number
      estimatedTokens: number
    }> = []

    for (const span of spans) {
      if (span.text.length <= maxChars) {
        chunks.push({
          id: `chunk-${chunks.length + 1}`,
          order: chunks.length,
          text: span.text,
          spanIds: [span.id],
          pageStart: span.page,
          pageEnd: span.page,
          estimatedTokens: Math.ceil(span.text.length / 2),
        })
        continue
      }

      for (let offset = 0; offset < span.text.length; offset += maxChars) {
        const piece = span.text.slice(offset, offset + maxChars)
        chunks.push({
          id: `chunk-${chunks.length + 1}`,
          order: chunks.length,
          text: piece,
          spanIds: [span.id],
          pageStart: span.page,
          pageEnd: span.page,
          estimatedTokens: Math.ceil(piece.length / 2),
        })
      }
    }

    // 自检：拼回去必须与原文逐字符相等，否则宁可不产出
    for (const span of spans) {
      const joined = chunks
        .filter((chunk) => chunk.spanIds[0] === span.id)
        .map((chunk) => chunk.text)
        .join('')
      if (joined !== span.text) {
        throw new Error(`chunk 拼接校验失败（span ${span.id}）：切片丢字符`)
      }
    }

    const chunkSet: ChunkSet = chunkSetSchema.parse({ sourceId: sourceDoc.sourceId, chunks })

    return { outputs: { chunkSet }, usage: ZERO_USAGE }
  },
}
