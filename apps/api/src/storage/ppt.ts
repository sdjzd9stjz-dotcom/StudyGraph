/**
 * 旧版 `.ppt`（Office 97–2003）文本抽取。
 *
 * 和 `.pptx` 完全是两种东西：`.pptx` 是 zip + XML，`.ppt` 是 **OLE2 复合文档**，
 * 里面的 "PowerPoint Document" 流是一棵定长头的记录树，文字放在
 * `TextCharsAtom`（UTF-16LE）或 `TextBytesAtom`（单字节）里。
 *
 * 所以这里要自己实现：CFB 容器读取 + 记录遍历。**不引入新依赖**，
 * 与 `pptx.ts` 自己写最小 zip 读取器的做法一致。
 *
 * 诚实说明边界：
 * - 只取文字，不还原版式、不取图片里的字（没有 OCR）
 * - 母版/备注里的文字也会被算进去（记录层无法可靠区分时宁可多取，
 *   由 `assessTextLayer` 那层判断可用性）
 * - 抽不出文字时**明确报错**，让用户另存为 .pptx —— 绝不返回空页假装成功
 */

export interface PptExtraction {
  /** 每页（每张幻灯片）的文字，按出现顺序 */
  readonly pages: string[]
}

const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** 记录类型 */
const REC_SLIDE = 0x03ee
const REC_TEXT_CHARS = 0x0fa0
const REC_TEXT_BYTES = 0x0fa8

function isCfb(buffer: Buffer): boolean {
  return buffer.length >= 512 && buffer.subarray(0, 8).equals(CFB_SIGNATURE)
}

interface DirEntry {
  readonly name: string
  readonly type: number
  readonly startSector: number
  readonly size: number
}

/**
 * 最小 CFB 读取器。
 *
 * 只做读取 "PowerPoint Document" 这一个流需要的事：
 * FAT 链、目录项、以及小流用的 miniFAT。
 */
function readCfbStream(buffer: Buffer, wantedName: string): Buffer {
  const sectorShift = buffer.readUInt16LE(0x1e)
  const miniSectorShift = buffer.readUInt16LE(0x20)
  const sectorSize = 1 << sectorShift
  const miniSectorSize = 1 << miniSectorShift
  const firstDirSector = buffer.readUInt32LE(0x30)
  const miniCutoff = buffer.readUInt32LE(0x38)
  const firstMiniFatSector = buffer.readUInt32LE(0x3c)
  const numFatSectors = buffer.readUInt32LE(0x2c)
  const firstDifatSector = buffer.readUInt32LE(0x44)
  const numDifatSectors = buffer.readUInt32LE(0x48)

  const sectorOffset = (sector: number) => (sector + 1) * sectorSize
  const readSector = (sector: number): Buffer => {
    const start = sectorOffset(sector)
    // 末尾扇区可能被截断（文件不按 512 对齐），按实际长度取
    return buffer.subarray(start, Math.min(start + sectorSize, buffer.length))
  }

  // ── DIFAT：前 109 个直接在头里，其余在 DIFAT 扇区链上 ──
  const fatSectorIds: number[] = []
  for (let i = 0; i < 109; i++) {
    const id = buffer.readUInt32LE(0x4c + i * 4)
    if (id === 0xffffffff) break
    fatSectorIds.push(id)
  }
  let difatSector = firstDifatSector
  for (let guard = 0; guard < numDifatSectors && difatSector !== 0xffffffff && difatSector !== 0xfffffffe; guard++) {
    const sector = readSector(difatSector)
    const perSector = sectorSize / 4 - 1
    for (let i = 0; i < perSector; i++) {
      const id = sector.readUInt32LE(i * 4)
      if (id === 0xffffffff) continue
      fatSectorIds.push(id)
    }
    difatSector = sector.readUInt32LE(perSector * 4)
  }

  // ── FAT：把所有 FAT 扇区拼成一张表 ──
  const fat: number[] = []
  for (const id of fatSectorIds.slice(0, numFatSectors || fatSectorIds.length)) {
    const sector = readSector(id)
    for (let i = 0; i + 4 <= sector.length; i += 4) fat.push(sector.readUInt32LE(i))
  }

  /** 按 FAT 链把一个流读出来；endOfChain 之后的内容丢弃 */
  const readChain = (start: number, size: number, table: readonly number[], read: (id: number) => Buffer): Buffer => {
    const chunks: Buffer[] = []
    let current = start
    let guard = 0
    while (current !== 0xfffffffe && current !== 0xffffffff && current < table.length + 1 && guard < 100000) {
      chunks.push(read(current))
      current = table[current] ?? 0xfffffffe
      guard += 1
    }
    const joined = Buffer.concat(chunks)
    return size > 0 && size < joined.length ? joined.subarray(0, size) : joined
  }

  // ── 目录 ──
  const dirBytes = readChain(firstDirSector, 0, fat, readSector)
  const entries: DirEntry[] = []
  for (let offset = 0; offset + 128 <= dirBytes.length; offset += 128) {
    const nameLength = dirBytes.readUInt16LE(offset + 0x40)
    if (nameLength < 2 || nameLength > 64) continue
    const name = dirBytes.subarray(offset, offset + nameLength - 2).toString('utf16le')
    const type = dirBytes.readUInt8(offset + 0x42)
    const startSector = dirBytes.readUInt32LE(offset + 0x74)
    // 大小是 8 字节；实际 .ppt 不会超过 4GB，取低 32 位足够
    const size = dirBytes.readUInt32LE(offset + 0x78)
    entries.push({ name, type, startSector, size })
  }

  const root = entries.find((entry) => entry.type === 5)
  const target = entries.find((entry) => entry.type === 2 && entry.name === wantedName)
  if (!target) throw new Error(`不是合法的 PowerPoint 文件：找不到「${wantedName}」流`)

  // 大流走 FAT；小于阈值的流走 miniFAT + 根目录的 mini stream
  if (target.size >= miniCutoff) {
    return readChain(target.startSector, target.size, fat, readSector)
  }

  if (!root) throw new Error('复合文档缺少根目录项，无法读取小流')
  const miniStream = readChain(root.startSector, root.size, fat, readSector)

  const miniFat: number[] = []
  let miniFatSector = firstMiniFatSector
  const sectorCount = Math.ceil(target.size / miniSectorSize) + 16
  for (let guard = 0; guard < sectorCount && miniFatSector !== 0xffffffff && miniFatSector !== 0xfffffffe; guard++) {
    const sector = readSector(miniFatSector)
    for (let i = 0; i + 4 <= sector.length; i += 4) miniFat.push(sector.readUInt32LE(i))
    miniFatSector = fat[miniFatSector] ?? 0xfffffffe
  }

  return readChain(target.startSector, target.size, miniFat, (id) =>
    miniStream.subarray(id * miniSectorSize, Math.min((id + 1) * miniSectorSize, miniStream.length)),
  )
}

/** 记录遍历：把一段记录缓冲区里的文字按幻灯片分组 */
function walkRecords(buffer: Buffer): { pages: string[][]; loose: string[] } {
  const pages: string[][] = []
  const loose: string[] = []
  let current: string[] | null = null

  const walk = (start: number, end: number): void => {
    let offset = start
    while (offset + 8 <= end) {
      const type = buffer.readUInt16LE(offset + 2)
      const length = buffer.readUInt32LE(offset + 4)
      const bodyStart = offset + 8
      const bodyEnd = Math.min(bodyStart + length, end)
      if (length > end - bodyStart) break

      if (type === REC_SLIDE) {
        const page: string[] = []
        pages.push(page)
        const previous = current
        current = page
        walk(bodyStart, bodyEnd)
        current = previous
      } else if (type === REC_TEXT_CHARS) {
        const text = buffer.subarray(bodyStart, bodyEnd).toString('utf16le')
        ;(current ?? loose).push(text)
      } else if (type === REC_TEXT_BYTES) {
        const text = buffer.subarray(bodyStart, bodyEnd).toString('latin1')
        ;(current ?? loose).push(text)
      } else {
        walk(bodyStart, bodyEnd)
      }

      offset = bodyEnd
    }
  }

  walk(0, buffer.length)
  return { pages, loose }
}

/** PowerPoint 用 \r 分段、\x0B 换行；\x00 是填充字节 */
function normalize(text: string): string {
  return text
    .replace(/\x00/g, '')
    .replace(/\r/g, '\n')
    .replace(/\x0b/g, '\n')
    .replace(/\x0d/g, '\n')
    .trim()
}

/**
 * 抽 `.ppt` 的文字。
 *
 * 找不到幻灯片记录时退化成"整份文档一页"——比直接报错有用，
 * 但如果一个字符都没抽到，返回空数组，由调用方明确报错。
 */
export function extractPpt(buffer: Buffer): PptExtraction {
  if (!isCfb(buffer)) {
    // 常见情况：把 .pptx 改名成 .ppt。给出能直接照做的提示。
    throw new Error(
      '这个文件不是旧版 .ppt 格式（不是 OLE2 复合文档）。' +
        '如果你把 .pptx 改名成了 .ppt，请改回 .pptx 再上传。',
    )
  }

  const stream = readCfbStream(buffer, 'PowerPoint Document')
  const { pages, loose } = walkRecords(stream)

  const normalizedPages = pages.map((parts) => normalize(parts.join('\n'))).filter((text) => text.length > 0)
  if (normalizedPages.length > 0) return { pages: normalizedPages }

  const fallback = normalize(loose.join('\n'))
  return { pages: fallback.length > 0 ? [fallback] : [] }
}
