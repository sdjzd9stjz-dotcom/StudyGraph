import { readFileSync } from 'node:fs'

import { getDocumentProxy } from 'unpdf'

/**
 * PDF 文本抽取。
 *
 * 只负责"拿到逐页纯文本"，不做版面分析。扫描件（无文字层）会得到空字符串，
 * 由调用方判定为 `SOURCE_HAS_NO_TEXT_LAYER`——这里**绝不**生成任何占位内容。
 */

export interface ExtractedPage {
  readonly page: number
  readonly region: 'PAGE'
  readonly text: string
}

export interface PdfExtraction {
  readonly pageCount: number
  readonly pages: ExtractedPage[]
}

export async function extractPdf(buffer: Uint8Array): Promise<PdfExtraction> {
  const pdf = await getDocumentProxy(buffer)
  const pages: ExtractedPage[] = []

  for (let page = 1; page <= pdf.numPages; page++) {
    const docPage = await pdf.getPage(page)
    const content = await docPage.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join('')
    pages.push({ page, region: 'PAGE', text })
  }

  return { pageCount: pdf.numPages, pages }
}

export async function extractPdfFile(filePath: string): Promise<PdfExtraction> {
  return extractPdf(new Uint8Array(readFileSync(filePath)))
}
