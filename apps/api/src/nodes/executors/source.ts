import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { sourceDocSchema } from '../../../../../packages/contracts/src/index.ts'
import type { SourceDoc } from '../../../../../packages/contracts/src/index.ts'
import { sourceHasNoTextLayer, sourceTextLayerUnusable } from '../../lib/errors.ts'
import { originalKey, pageTextKey, writePageTexts } from '../../storage/page-text.ts'
import { extractSource, sha256Of } from '../../storage/extract-text.ts'
import { assessTextLayer } from '../../storage/text-layer.ts'
import type { NodeExecutor } from '../contract.ts'
import { ZERO_USAGE } from '../contract.ts'

interface SourceParams {
  /** 本地文件路径（M2 用；M4 的 upload API 会把文件先落到 S3 再传 key） */
  localPath: string
  filename?: string
  /**
   * 用户在界面上勾了「这是扫描件」。
   *
   * 只影响没有文字层的 PDF：允许走 OCR。没有这个标记时，无文字层照旧报错 ——
   * OCR 是猜字，不能被默认打开（见 storage/pdf-ocr.ts）。
   */
  ocr?: boolean
}

/**
 * `source` 节点：文件 → 原文 + span 索引。
 *
 * - `Source.pageCount` = 真实页数（PPTX = 幻灯片数），不是填死值
 * - `Source.checksum` = 文件 sha256
 * - **指纹必须含文件内容**（SG-SUP-008 §1）：同名文件被覆盖后必须重跑，
 *   不能因为路径没变就命中缓存。见 `prepareFingerprintParams`。
 * - 两层闸门：0 字符 → `SOURCE_HAS_NO_TEXT_LAYER`；
 *   有字符但不可用（劣质 OCR）→ `SOURCE_TEXT_LAYER_UNUSABLE`
 */
export const sourceExecutor: NodeExecutor<SourceParams> = {
  type: 'SOURCE',
  artifactKind: 'SOURCE_TEXT',
  promptVersion: 'no-prompt',
  inputs: { type: 'object', properties: {}, required: [] },
  outputs: { type: 'object', properties: { sourceDoc: { type: 'object' } }, required: ['sourceDoc'] },

  /**
   * 指纹参数 = 路径 + **文件内容 sha256** + 字节数（SG-SUP-008 §1.3）。
   *
   * 读不到文件就直接抛：绝不退回"只用路径"算指纹——那等于把这条 P0 换个写法留着。
   */
  async prepareFingerprintParams(params) {
    const buffer = readFileSync(params.localPath)
    return { ...params, contentSha256: sha256Of(buffer), byteSize: buffer.length }
  },

  async run(ctx) {
    const localPath = ctx.params.localPath
    if (!localPath) throw new Error('source 节点缺少 params.localPath')

    const filename = ctx.params.filename ?? basename(localPath)
    // 只有用户明确标了"这是扫描件"才允许 OCR（见 extractSource 的 ExtractOptions）
    const extraction = await extractSource(localPath, { ocr: ctx.params.ocr === true })

    // 第一层：一个字符都没有 → 没有文字层
    if (extraction.textChars === 0) {
      throw sourceHasNoTextLayer(filename)
    }

    // 第二层：有字符但不构成可用文本（劣质 OCR）→ 同样拒绝，但不建任何行
    const assessment = assessTextLayer(extraction.pages)
    if (!assessment.usable) {
      throw sourceTextLayerUnusable(filename, {
        totalPages: assessment.totalPages,
        nonEmptyPages: assessment.nonEmptyPages,
        signals: assessment.signals.length > 0 ? assessment.signals : [assessment.reason],
      })
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

    /**
     * `textLayer` 必须进产物。
     *
     * `OCR` 意味着这些"原文"是从像素猜出来的 —— 下游做引用时必须知道这一点，
     * 否则一张卡会声称"原文第 2 页这么写"，而那句话其实是识别结果。
     * 不是给程序看的开关，是给人看的交代。
     */
    return {
      outputs: {
        sourceDoc,
        textLayer: extraction.textLayer ?? 'NATIVE',
        ...(extraction.ocr ? { ocr: extraction.ocr } : {}),
      },
      usage: ZERO_USAGE,
    }
  },
}
