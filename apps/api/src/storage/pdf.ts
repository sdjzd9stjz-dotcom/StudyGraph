import { readFileSync } from 'node:fs'

/**
 * PDF 文本抽取。
 *
 * 只负责"拿到逐页纯文本"，不做版面分析。扫描件（无文字层）会得到空字符串，
 * 由调用方判定为 `SOURCE_HAS_NO_TEXT_LAYER` —— 这里**绝不**生成任何占位内容。
 *
 * 为什么不用 unpdf：它把一份 pdfjs 打进自己的 dist（6.5.438），而 OCR 侧用
 * `pdf-to-img` → `pdfjs-dist`（6.4.299）。同一进程里两套 pdfjs 会互相干扰，
 * 表现为 `The API version "6.4.299" does not match the Worker version "6.5.438"`，
 * 而且只在打包后出现。这里统一用 pdfjs-dist，进程里只留一套引擎。
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

/** 与 pdf-ocr 共用同一个 pdfjs 入口，避免两份模块实例各存各的状态 */
export async function loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  return import('pdfjs-dist/legacy/build/pdf.mjs')
}

export async function extractPdf(buffer: Uint8Array): Promise<PdfExtraction> {
  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument({
    // 复制一份：pdfjs 会接管并可能 detach 传入的 buffer，调用方还要拿它算 sha256
    data: new Uint8Array(buffer),
  })
  const document = await task.promise
  const pages: ExtractedPage[] = []

  try {
    for (let page = 1; page <= document.numPages; page++) {
      const docPage = await document.getPage(page)
      const content = await docPage.getTextContent()
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
      pages.push({ page, region: 'PAGE', text })
      docPage.cleanup()
    }

    return { pageCount: document.numPages, pages }
  } finally {
    // 释放通过 loadingTask 做：document 上没有 destroy（不同版本导出不一致）
    await task.destroy()
  }
}

export async function extractPdfFile(filePath: string): Promise<PdfExtraction> {
  return extractPdf(new Uint8Array(readFileSync(filePath)))
}
