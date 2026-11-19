import { basename } from 'node:path'

import { sourceDocSchema } from '../../../../../packages/contracts/src/index.ts'
import type { SourceDoc } from '../../../../../packages/contracts/src/index.ts'
import { sourceHasNoTextLayer } from '../../lib/errors.ts'
import { originalKey, pageTextKey, writePageTexts } from '../../storage/page-text.ts'
import { extractSource } from '../../storage/extract-text.ts'
import type { NodeExecutor } from '../contract.ts'
import { ZERO_USAGE } from '../contract.ts'

interface SourceParams {
  /** 本地文件路径（M2 用；M4 的 upload API 会把文件先落到 S3 再传 key） */
  localPath: string
  filename?: string
}

/**
 * `source` 节点：文件 → 原文 + span 索引。
 *
 * - `Source.pageCount` = 真实页数（PPTX = 幻灯片数），不是填死值
 * - `Source.checksum` = 文件 sha256
 * - 原文落 S3：`canvas/<cv>/source/<id>/original.<ext>`；页文本落 `.../text.json`
 * - **扫描件（无文字层）必须失败**：返回 422 `SOURCE_HAS_NO_TEXT_LAYER`，0 个 span，不生成任何内容
 */
export const sourceExecutor: NodeExecutor<SourceParams> = {
  type: 'SOURCE',
  artifactKind: 'SOURCE_TEXT',
  promptVersion: 'no-prompt',
  inputs: { type: 'object', properties: {}, required: [] },
  outputs: { type: 'object', properties: { sourceDoc: { type: 'object' } }, required: ['sourceDoc'] },

  async run(ctx) {
    const localPath = ctx.params.localPath
    if (!localPath) throw new Error('source 节点缺少 params.localPath')

    const filename = ctx.params.filename ?? basename(localPath)
    const extraction = await extractSource(localPath)

    // 扫描件/纯图课件：解析成功但没有文字层 → 明确失败，绝不生成内容
    if (extraction.textChars === 0) {
      throw sourceHasNoTextLayer(filename)
    }

    const source = await ctx.prisma.source.create({
      data: {
        nodeId: ctx.nodeId,
        kind: extraction.kind,
        filename,
        mimeType: extraction.kind === 'PPTX' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/pdf',
        pageCount: extraction.pageCount,
        byteSize: extraction.byteSize,
        checksum: extraction.checksum,
      },
    })

    const textKey = pageTextKey(ctx.canvasId, source.id)
    await writePageTexts(
      ctx.objectStore,
      ctx.canvasId,
      source.id,
      extraction.pages.map((page) => ({ page: page.page, region: page.region, text: page.text })),
    )

    // 原文也留一份，便于以后重解析
    const { readFileSync } = await import('node:fs')
    const original = originalKey(ctx.canvasId, source.id, filename)
    await ctx.objectStore.put(original, readFileSync(localPath), 'application/octet-stream')

    // 每个非空页/幻灯片建一个 span（覆盖整页文本，[0, text.length)）
    let spanCount = 0
    for (const page of extraction.pages) {
      if (page.text.trim().length === 0) continue
      await ctx.prisma.span.create({
        data: {
          sourceId: source.id,
          page: page.page,
          region: page.region,
          charStart: 0,
          charEnd: page.text.length,
          text: page.text,
        },
      })
      spanCount += 1
    }

    await ctx.prisma.source.update({
      where: { id: source.id },
      data: { s3Key: original, parsedAt: new Date() },
    })

    const sourceDoc: SourceDoc = sourceDocSchema.parse({
      sourceId: source.id,
      filename,
      mimeType: extraction.kind === 'PPTX' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/pdf',
      pageCount: extraction.pageCount,
      checksum: extraction.checksum,
      textKey,
      spanCount,
    })

    return { outputs: { sourceDoc }, usage: ZERO_USAGE }
  },
}
