// PPTX 文本计数的**唯一权威口径**（SG-SUP-007 §6）。
//
// 口径定义（逐条写清，避免再出现 6101 vs 5842 这种对不上的数）：
//   1. 只统计 `ppt/slides/slideN.xml`，**不含** slideLayout / slideMaster（模板文字会污染）
//   2. 文本节点是 `<a:t>…</a:t>`（含表格 `<a:tbl>` 里的，因为表格文字也在 `<a:t>` 中）
//   3. 备注页 `ppt/notesSlides/notesSlideN.xml` **单独统计**，不计入正文
//   4. 不做去重、不做空白压缩；同时给出 "trim 后" 的字符数供参考
//   5. 字符数 = 文本节点的 Unicode 码点数（JS string.length 口径，与 Span 偏移一致）
//
// 输出：每个文件的幻灯片数、正文/备注字符数、空文本页数，以及合计。
//
// 用法：node scripts/count-pptx.mjs [目录]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import path from 'node:path'

/** 最小 ZIP 读取器（只读中央目录 + inflateRaw），避免为计数引入依赖。 */
function readZipEntries(buffer) {
  const EOCD = 0x06054b50
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 65558; i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是合法的 zip/pptx（找不到 EOCD）')

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = []

  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录损坏')
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

const TEXT_NODE = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g

function extractText(xml) {
  const pieces = []
  for (const match of xml.matchAll(TEXT_NODE)) {
    // XML 实体还原：&amp; 等会影响字符数，先还原再计
    pieces.push(
      match[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&'),
    )
  }
  return pieces
}

export function analysePptx(filePath) {
  const entries = readZipEntries(readFileSync(filePath))
  const byName = new Map(entries.map((entry) => [entry.name, entry]))

  const slideNames = [...byName.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]))

  const notesNames = [...byName.keys()].filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))

  let slideChars = 0
  let slideCharsTrimmed = 0
  let slideCharsNonEmpty = 0
  const perSlide = []
  let emptySlides = 0

  for (const name of slideNames) {
    const pieces = extractText(byName.get(name).read())
    const text = pieces.join('')
    slideChars += text.length
    slideCharsTrimmed += text.replace(/\s+/g, '').length
    // 只算"非纯空白"的文本节点：这一列与验收方 5842 的口径一致
    slideCharsNonEmpty += pieces.reduce((sum, piece) => sum + (piece.trim().length > 0 ? piece.length : 0), 0)
    if (text.trim().length === 0) emptySlides += 1
    perSlide.push({ slide: Number(name.match(/(\d+)/)[1]), chars: text.length })
  }

  let notesChars = 0
  for (const name of notesNames) {
    notesChars += extractText(byName.get(name).read()).join('').length
  }

  // 防呆：把母版/版式也数一遍，明确"没算进去"
  let masterChars = 0
  for (const name of byName.keys()) {
    if (/^ppt\/(slideMasters|slideLayouts)\/.*\.xml$/.test(name)) {
      masterChars += extractText(byName.get(name).read()).join('').length
    }
  }

  return {
    file: path.basename(filePath),
    slides: slideNames.length,
    notesSlides: notesNames.length,
    slideChars,
    slideCharsTrimmed,
    slideCharsNonEmpty,
    notesChars,
    emptySlides,
    masterAndLayoutCharsExcluded: masterChars,
    perSlide,
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const root = process.argv[2] ?? '课件'
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.toLowerCase().endsWith('.pptx')) files.push(full)
    }
  }
  walk(root)

  const results = files.map(analysePptx).sort((a, b) => a.file.localeCompare(b.file))
  const totals = results.reduce(
    (acc, item) => ({
      slides: acc.slides + item.slides,
      slideChars: acc.slideChars + item.slideChars,
      slideCharsTrimmed: acc.slideCharsTrimmed + item.slideCharsTrimmed,
      slideCharsNonEmpty: acc.slideCharsNonEmpty + item.slideCharsNonEmpty,
      notesChars: acc.notesChars + item.notesChars,
      emptySlides: acc.emptySlides + item.emptySlides,
      masterChars: acc.masterChars + item.masterAndLayoutCharsExcluded,
    }),
    { slides: 0, slideChars: 0, slideCharsTrimmed: 0, slideCharsNonEmpty: 0, notesChars: 0, emptySlides: 0, masterChars: 0 },
  )

  console.log(
    JSON.stringify(
      { files: results.map(({ perSlide, ...rest }) => rest), totals },
      null,
      2,
    ),
  )
}
