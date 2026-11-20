import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

/**
 * PPTX 文本抽取（SG-SUP-007 §2.1）。
 *
 * 只取 `ppt/slides/slideN.xml` 与 `ppt/notesSlides/notesSlideN.xml` 里的 `<a:t>`：
 * - 表格文字也在 `<a:t>` 里，天然包含
 * - 母版/版式（slideMaster / slideLayout）**不抽**，模板文字会污染引用（实测 3666 字符）
 * - 图片里的文字不抽（无 OCR）；这类页文本为 0，调用方不得凭空生成内容
 *
 * 页文本 = 该页 `<a:t>` 按文档顺序拼接，**不做空白压缩、不做规范化**（偏移基准见 architecture §3.1）。
 */

const TEXT_NODE = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g

interface ZipEntry {
  readonly name: string
  readonly read: () => string
}

/** 最小 ZIP 读取器：中央目录 + inflateRaw，不引入解压依赖。 */
function readZipEntries(buffer: Buffer): ZipEntry[] {
  const EOCD = 0x06054b50
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 65558; i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是合法的 PPTX（找不到 zip 中央目录）')

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []

  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('PPTX 中央目录损坏')

    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)

    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)

    entries.push({
      name,
      read: () => (method === 0 ? raw : inflateRawSync(raw)).toString('utf8'),
    })

    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function textOf(xml: string): string {
  const pieces: string[] = []
  for (const match of xml.matchAll(TEXT_NODE)) pieces.push(decodeEntities(match[1] ?? ''))
  return pieces.join('')
}

export interface ExtractedPage {
  readonly page: number
  readonly region: 'SLIDE' | 'NOTES'
  readonly text: string
}

export interface PptxExtraction {
  readonly slideCount: number
  readonly pages: ExtractedPage[]
}

function numericSuffix(name: string): number {
  return Number(name.match(/(\d+)/)?.[1] ?? 0)
}

export function extractPptx(buffer: Buffer): PptxExtraction {
  const entries = readZipEntries(buffer)
  const byName = new Map(entries.map((entry) => [entry.name, entry]))

  const slideNames = [...byName.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => numericSuffix(a) - numericSuffix(b))

  if (slideNames.length === 0) throw new Error('PPTX 里没有幻灯片（ppt/slides/ 为空）')

  const pages: ExtractedPage[] = slideNames.map((name, index) => ({
    page: index + 1,
    region: 'SLIDE',
    text: textOf(byName.get(name)!.read()),
  }))

  // 备注页：按 slideN 对齐（notesSlideN 与 slideN 的序号通常一致）
  const notesNames = [...byName.keys()]
    .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
    .sort((a, b) => numericSuffix(a) - numericSuffix(b))

  for (const name of notesNames) {
    const page = Number(name.match(/(\d+)/)?.[1] ?? 0)
    const text = textOf(byName.get(name)!.read())
    if (text.trim().length === 0) continue // 空备注不建 span，也不占用区域
    pages.push({ page, region: 'NOTES', text })
  }

  return { slideCount: slideNames.length, pages }
}

export function extractPptxFile(filePath: string): PptxExtraction {
  return extractPptx(readFileSync(filePath))
}
