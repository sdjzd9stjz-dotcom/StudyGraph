import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { pdf } from 'pdf-to-img'
import { createWorker } from 'tesseract.js'

import type { StoredPageText } from './page-text.ts'

/**
 * 纯图片 PDF（扫描件）的文字识别。
 *
 * 为什么必须显式开启：OCR 出来的文字**不是原文**，是把像素猜成字。
 * 这个项目的硬约束是"结论必须能回到原文"，而 OCR 文字只能回到"我们猜它写了什么"。
 * 所以默认仍然拒绝没有文字层的 PDF，只有用户明确说"这是扫描件，试试"才走这里，
 * 产出也要在产物里标成 OCR，别让人以为那是原生文字层。
 *
 * 实现：pdf-to-img 渲染（内部用 pdfjs + 原生 canvas）+ tesseract.js（WASM）。
 * 语言包必须本地带（chi_sim + eng，约 31MB），否则没网的电脑上第一次用就失败。
 */

/** 一次最多识别多少页：OCR 单页约 1–3 秒，几百页会让人以为程序卡死 */
const MAX_OCR_PAGES = 60

/** 渲染倍率：2 倍 A4 约 150 DPI，是 OCR 精度与耗时的平衡点 */
const RENDER_SCALE = 2

/**
 * 找到放语言包的目录。
 *
 * 桌面版由主进程通过 `STUDYGRAPH_OCR_LANG_DIR` 指向 `resources/ocr`；
 * 开发期把两个包目录里的 .gz 合并到 tmp 下的缓存目录 —— tesseract 的 langPath
 * 只接受一个目录，而 npm 包把每种语言放在各自的目录里。
 */
function resolveLangDir(): string {
  const explicit = process.env.STUDYGRAPH_OCR_LANG_DIR
  if (explicit) {
    if (!existsSync(path.join(explicit, 'chi_sim.traineddata.gz'))) {
      throw new Error(`OCR 语言包缺失：${explicit} 里没有 chi_sim.traineddata.gz`)
    }
    return explicit
  }

  const cacheDir = path.join(process.cwd(), 'tmp', 'ocr-langs')
  mkdirSync(cacheDir, { recursive: true })
  const wanted: Array<[string, string]> = [
    ['chi_sim', '@tesseract.js-data/chi_sim/4.0.0/chi_sim.traineddata.gz'],
    ['eng', '@tesseract.js-data/eng/4.0.0/eng.traineddata.gz'],
  ]
  for (const [lang, relative] of wanted) {
    const target = path.join(cacheDir, `${lang}.traineddata.gz`)
    if (existsSync(target)) continue
    const source = path.join(process.cwd(), 'node_modules', ...relative.split('/'))
    if (!existsSync(source)) {
      throw new Error(
        `OCR 语言包缺失：找不到 ${source}。开发期需要安装 @tesseract.js-data/${lang}。`,
      )
    }
    copyFileSync(source, target)
  }
  return cacheDir
}

export interface OcrOutcome {
  readonly pages: StoredPageText[]
  /** 被截断的页数（超过上限没识别） */
  readonly skippedPages: number
  /** 识别引擎给出的平均置信度（0–100） */
  readonly confidence: number
}

/**
 * 把 PDF 每页渲染成图再交给 OCR。
 *
 * 不并行：tesseract 的 worker 本身就是多线程的，再并发只会抢 CPU 让整体更慢。
 */
/**
 * 把 pdfjs 的 worker 钉在本机文件上。
 *
 * 不钉的话它默认从 CDN 取 worker —— 于是出现
 * 「API version 6.4.299 does not match Worker version 6.5.438」，
 * 而且是在**装了包的用户机器上**才炸（开发机恰好能取到匹配版本）。
 * 打包后必须完全离线可用，所以这里指向随包发布的 worker 文件。
 */
async function pinPdfWorker(): Promise<void> {
  const require = createRequire(import.meta.url)
  /**
   * 两份都要钉。
   *
   * pdfjs 有两个入口（`pdfjs-dist` 与 `pdfjs-dist/legacy/...`），它们是**不同的模块实例**，
   * GlobalWorkerOptions 各存各的。pdf-to-img 用的是前者，我们日志里读到的是后者 ——
   * 只钉一份，另一份仍会去 CDN 取 worker，于是版本对不上。
   */
  const targets: Array<[string, string]> = [
    ['pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist/legacy/build/pdf.worker.mjs'],
    ['pdfjs-dist', 'pdfjs-dist/build/pdf.worker.mjs'],
  ]
  for (const [apiPath, workerPath] of targets) {
    try {
      const mod = (await import(apiPath)) as { GlobalWorkerOptions?: { workerSrc: string } }
      if (!mod.GlobalWorkerOptions) continue
      /**
       * 必须是 `file://` URL，不能是 Windows 绝对路径。
       *
       * pdfjs 用动态 import 加载 worker，Windows 路径 `D:\...` 会被当成协议名 `d:`，
       * 报 "Received protocol 'd:'" —— 而且只在 Windows 上炸，让人以为是环境问题。
       */
      mod.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve(workerPath)).href
    } catch {
      // 某个入口不存在时忽略：至少另一份已经钉住，且 pdfjs 会退回同线程假 worker
    }
  }
}

export async function ocrPdf(buffer: Buffer): Promise<OcrOutcome> {
  const langDir = resolveLangDir()
  await pinPdfWorker()
  const pages: StoredPageText[] = []
  let skippedPages = 0
  let confidenceSum = 0
  let confidenceCount = 0

  const worker = await createWorker(['chi_sim', 'eng'], 1, {
    langPath: langDir,
    cachePath: langDir,
    gzip: true,
    // 这几行是给 OCR 引擎的内部日志降噪：它默认会把每一步都打到 stderr
    logger: () => {},
  })

  try {
    const document = await pdf(buffer, { scale: RENDER_SCALE })
    let pageNumber = 0
    for await (const image of document) {
      pageNumber += 1
      if (pageNumber > MAX_OCR_PAGES) {
        skippedPages += 1
        continue
      }
      const { data } = await worker.recognize(image)
      const text = normalizeOcrText(data.text)
      if (typeof data.confidence === 'number') {
        confidenceSum += data.confidence
        confidenceCount += 1
      }
      pages.push({ page: pageNumber, region: 'PAGE', text })
    }
  } finally {
    await worker.terminate()
  }

  return {
    pages,
    skippedPages,
    confidence: confidenceCount > 0 ? Math.round(confidenceSum / confidenceCount) : 0,
  }
}

/**
 * 收拾 OCR 输出。
 *
 * tesseract 会在中文之间插空格（"导 数 与 微 分"）—— 那是它的分词产物，不是原文。
 * 中文之间的空格必须去掉，否则下游按句子切分、按关键词匹配全都会失效。
 * 但**中英文之间**的空格要保留（`x^2 的 导 数` 里英文与中文之间）。
 */
export function normalizeOcrText(raw: string): string {
  return raw
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) =>
      line
        // 两个 CJK 字符之间夹空格 → 去掉
        .replace(/([一-鿿])[ \t]+(?=[一-鿿])/g, '$1')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
