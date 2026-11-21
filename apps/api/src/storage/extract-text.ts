import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { StoredPageText } from './page-text.ts'
import { extractPptx } from './pptx.ts'
import { extractPpt } from './ppt.ts'
import { extractPdf } from './pdf.ts'
import { ocrPdf } from './pdf-ocr.ts'

/**
 * 按文件类型分派抽取。
 *
 * 只有"有文字层"的材料能产出 span；扫描件返回 `textLayer: false`，
 * 由 source executor 转成 422 + 给用户看的说明。
 */
export type SourceKindDetected = 'PPTX' | 'PPT' | 'PDF'

export interface ExtractionResult {
  readonly kind: SourceKindDetected
  readonly pageCount: number
  readonly pages: StoredPageText[]
  /** 有文字的总字符数（0 表示没有文字层） */
  readonly textChars: number
  readonly checksum: string
  readonly byteSize: number
  /**
   * 文字是怎么来的。缺省 `NATIVE` = 文件自带文字层。
   * `OCR` = 从页面像素识别出来的，**不是原文**，下游引用时必须让人看得出来。
   */
  readonly textLayer?: 'NATIVE' | 'OCR'
  readonly ocr?: { readonly confidence: number; readonly skippedPages: number }
}

export interface ExtractOptions {
  /**
   * 允许对没有文字层的 PDF 做 OCR。
   *
   * 默认 false：OCR 是猜测，会把"猜出来的文字"变成可被引用的原文 ——
   * 这件事必须由用户明确要求，不能因为"反正能抽点东西"就默默打开。
   */
  readonly ocr?: boolean
}

export function detectKind(filename: string): SourceKindDetected {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.pptx') return 'PPTX'
  if (ext === '.pdf') return 'PDF'
  if (ext === '.ppt') return 'PPT'
  throw new Error(`只支持 .pptx / .ppt / .pdf，收到：${ext || '(无扩展名)'}`)
}

export function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function extractSource(filePath: string, options: ExtractOptions = {}): Promise<ExtractionResult> {
  const buffer = readFileSync(filePath)
  const filename = path.basename(filePath)
  const kind = detectKind(filename)

  if (kind === 'PPTX') {
    const { slideCount, pages } = extractPptx(buffer)
    return {
      kind,
      pageCount: slideCount,
      pages,
      textChars: pages.reduce((sum, page) => sum + page.text.length, 0),
      checksum: sha256Of(buffer),
      byteSize: buffer.length,
    }
  }

  if (kind === 'PPT') {
    const { pages: rawPages } = extractPpt(buffer)
    // 抽不出文字就明说：空页会让下游概念抽取"成功"地产出 0 条，看起来像模型不行
    if (rawPages.length === 0) {
      throw new Error(
        '这份 .ppt 里没有抽到任何文字。可能是纯图片幻灯片（没有 OCR），' +
          '或使用了我们还不支持的记录类型。请用 PowerPoint 另存为 .pptx 后再上传。',
      )
    }
    const pages: StoredPageText[] = rawPages.map((text, index) => ({
      page: index + 1,
      region: 'SLIDE',
      text,
    }))
    return {
      kind,
      pageCount: pages.length,
      pages,
      textChars: pages.reduce((sum, page) => sum + page.text.length, 0),
      checksum: sha256Of(buffer),
      byteSize: buffer.length,
    }
  }

  const { pageCount, pages } = await extractPdf(new Uint8Array(buffer))
  const nativeChars = pages.reduce((sum, page) => sum + page.text.length, 0)

  // 有文字层就是普通 PDF，不碰 OCR
  if (nativeChars > 0) {
    return {
      kind,
      pageCount,
      pages,
      textChars: nativeChars,
      checksum: sha256Of(buffer),
      byteSize: buffer.length,
      textLayer: 'NATIVE',
    }
  }

  // 一个字符都没有 = 扫描件。只有用户明确要求才识别。
  if (!options.ocr) {
    return {
      kind,
      pageCount,
      pages,
      textChars: 0,
      checksum: sha256Of(buffer),
      byteSize: buffer.length,
      textLayer: 'NATIVE',
    }
  }

  const ocr = await ocrPdf(buffer)
  return {
    kind,
    pageCount: Math.max(pageCount, ocr.pages.length),
    pages: ocr.pages,
    textChars: ocr.pages.reduce((sum, page) => sum + page.text.length, 0),
    checksum: sha256Of(buffer),
    byteSize: buffer.length,
    textLayer: 'OCR',
    ocr: { confidence: ocr.confidence, skippedPages: ocr.skippedPages },
  }
}
