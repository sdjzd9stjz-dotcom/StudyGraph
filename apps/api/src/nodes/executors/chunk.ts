import { chunkSetSchema } from '../../../../../packages/contracts/src/index.ts'
import type { ChunkSet, SourceDoc } from '../../../../../packages/contracts/src/index.ts'
import type { NodeExecutor } from '../contract.ts'
import { ZERO_USAGE } from '../contract.ts'
import { nodeInputMissing } from '../../lib/errors.ts'

interface ChunkParams {
  /** 每片最多包含的 Unicode 码点数；不同原文片段分别切分，便于回查出处。 */
  maxChars?: number
}

/** maxChars 按 Unicode 码点计数，切片位置仍沿用原文的 UTF-16 偏移。 */
export function splitSpanText(text: string, maxChars: number): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('maxChars 必须是正整数')
  if (text.length <= maxChars) return [text]

  const pieces: string[] = []
  let start = 0
  let end = 0
  let count = 0
  // 数学斜体字母等字符占两个 UTF-16 码元。按字符移动才能让每一片独立写入 JSON。
  for (const character of text) {
    end += character.length
    count += 1
    if (count === maxChars) {
      pieces.push(text.slice(start, end))
      start = end
      count = 0
    }
  }
  if (start < end) pieces.push(text.slice(start))
  return pieces
}

export const chunkExecutor: NodeExecutor<ChunkParams> = {
  type: 'CHUNK',
  artifactKind: 'CHUNKS',
  promptVersion: 'chunk-unicode-v2',
  inputs: { type: 'object', properties: { sourceDoc: { type: 'object' } }, required: ['sourceDoc'] },
  outputs: { type: 'object', properties: { chunkSet: { type: 'object' } }, required: ['chunkSet'] },

  async run(ctx) {
    const sourceDoc = ctx.inputs.sourceDoc as SourceDoc | undefined
    if (!sourceDoc?.sourceId) throw nodeInputMissing('chunk 节点缺少上游 sourceDoc')

    const maxChars = ctx.params.maxChars ?? 800

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
      const pieces = splitSpanText(span.text, maxChars)
      if (pieces.join('') !== span.text) throw new Error(`chunk 拼接校验失败（span ${span.id}）：切片丢字符`)
      for (const piece of pieces) {
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

    const chunkSet: ChunkSet = chunkSetSchema.parse({ sourceId: sourceDoc.sourceId, chunks })

    return { outputs: { chunkSet }, usage: ZERO_USAGE }
  },
}
