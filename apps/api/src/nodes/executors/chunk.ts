import { chunkSetSchema } from '../../../../../packages/contracts/src/index.ts'
import type { ChunkSet, SourceDoc } from '../../../../../packages/contracts/src/index.ts'
import type { NodeExecutor } from '../contract.ts'
import { ZERO_USAGE } from '../contract.ts'

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
    if (!sourceDoc?.sourceId) throw new Error('chunk 节点缺少上游 sourceDoc')

    const maxChars = ctx.params.maxChars ?? 800

    const spans = await ctx.prisma.span.findMany({
      where: { sourceId: sourceDoc.sourceId },
      orderBy: [{ page: 'asc' }, { region: 'asc' }],
      select: { id: true, page: true, region: true, text: true },
    })

    if (spans.length === 0) {
      throw new Error(`source ${sourceDoc.sourceId} 没有任何 span，无法切片`)
    }

    const chunks = spans.map((span, index) => ({
      id: `chunk-${index + 1}`,
      order: index,
      text: span.text.length > maxChars ? span.text.slice(0, maxChars) : span.text,
      spanIds: [span.id],
      pageStart: span.page,
      pageEnd: span.page,
      estimatedTokens: Math.ceil(span.text.length / 2),
    }))

    const chunkSet: ChunkSet = chunkSetSchema.parse({ sourceId: sourceDoc.sourceId, chunks })

    return { outputs: { chunkSet }, usage: ZERO_USAGE }
  },
}
