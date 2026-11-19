import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { StoredPageText } from './page-text.ts'
import { extractPptx } from './pptx.ts'
import { extractPdf } from './pdf.ts'

/**
 * 按文件类型分派抽取。
 *
 * 只有"有文字层"的材料能产出 span；扫描件返回 `textLayer: false`，
 * 由 source executor 转成 422 + 给用户看的说明。
 */
export type SourceKindDetected = 'PPTX' | 'PDF'

export interface ExtractionResult {
  readonly kind: SourceKindDetected
  readonly pageCount: number
  readonly pages: StoredPageText[]
  /** 有文字的总字符数（0 表示没有文字层） */
  readonly textChars: number
  readonly checksum: string
  readonly byteSize: number
}

export function detectKind(filename: string): SourceKindDetected {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.pptx') return 'PPTX'
  if (ext === '.pdf') return 'PDF'
  throw new Error(`M2 只支持 .pptx 与 .pdf，收到：${ext || '(无扩展名)'}`)
}

export function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function extractSource(filePath: string): Promise<ExtractionResult> {
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

  const { pageCount, pages } = await extractPdf(new Uint8Array(buffer))
  return {
    kind,
    pageCount,
    pages,
    textChars: pages.reduce((sum, page) => sum + page.text.length, 0),
    checksum: sha256Of(buffer),
    byteSize: buffer.length,
  }
}
