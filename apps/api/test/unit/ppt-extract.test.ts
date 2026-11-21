import assert from 'node:assert/strict'
import test from 'node:test'

import { detectKind } from '../../src/storage/extract-text.ts'
import { extractPpt } from '../../src/storage/ppt.ts'

/**
 * `.ppt`（OLE2 复合文档）解析。
 *
 * 这个格式没有现成依赖可用，读取逻辑是手写的 —— 手写的二进制解析必须有测试，
 * 否则"能跑"只是因为恰好碰到了一种文件布局。
 *
 * 测试用的 CFB 是**在测试里现场构造**的，覆盖两条真实存在的读取路径：
 *   · 流 ≥ 4096 字节 → 走 FAT 链（大文件，常见于完整课件）
 *   · 流 < 4096 字节 → 走 miniFAT + 根目录的 mini stream（小文件，几页的短课件）
 * 第二条更容易写错，也更容易被真实文件撞上。
 */

const SECTOR = 512
const ENDOFCHAIN = 0xfffffffe
const FATSECT = 0xfffffffd

/** 构造一条 PowerPoint 记录：2 字节版本/实例 + 2 字节类型 + 4 字节长度 */
function record(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt16LE(0x0000, 0)
  header.writeUInt16LE(type, 2)
  header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function textChars(text: string): Buffer {
  return record(0x0fa0, Buffer.from(text, 'utf16le'))
}

function slide(text: string): Buffer {
  return record(0x03ee, textChars(text))
}

function dirEntry(name: string, type: number, startSector: number, size: number): Buffer {
  const entry = Buffer.alloc(128)
  const nameBytes = Buffer.from(`${name}\0`, 'utf16le')
  nameBytes.copy(entry, 0)
  entry.writeUInt16LE(nameBytes.length, 0x40)
  entry.writeUInt8(type, 0x42)
  entry.writeUInt32LE(startSector, 0x74)
  entry.writeUInt32LE(size, 0x78)
  return entry
}

/** 把若干个扇区拼成文件（第一个扇区前面留 512 字节头） */
function assemble(header: Buffer, sectors: Buffer[]): Buffer {
  return Buffer.concat([header, ...sectors])
}

function headerFor(options: {
  fatSectors: number
  firstDirSector: number
  firstMiniFatSector: number
  numMiniFatSectors: number
}): Buffer {
  const header = Buffer.alloc(SECTOR)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0)
  header.writeUInt16LE(9, 0x1e) // 512 字节扇区
  header.writeUInt16LE(6, 0x20) // 64 字节 mini 扇区
  header.writeUInt32LE(options.fatSectors, 0x2c)
  header.writeUInt32LE(options.firstDirSector, 0x30)
  header.writeUInt32LE(4096, 0x38) // mini stream 阈值
  header.writeUInt32LE(options.firstMiniFatSector, 0x3c)
  header.writeUInt32LE(options.numMiniFatSectors, 0x40)
  header.writeUInt32LE(0xfffffffe, 0x44) // 无 DIFAT 扩展
  header.writeUInt32LE(0, 0x48)
  header.writeUInt32LE(0, 0x4c) // DIFAT[0] = 扇区 0（FAT）
  for (let i = 1; i < 109; i++) header.writeUInt32LE(0xffffffff, 0x4c + i * 4)
  return header
}

function fatSector(entries: number[]): Buffer {
  const sector = Buffer.alloc(SECTOR)
  for (let i = 0; i < SECTOR / 4; i++) {
    sector.writeUInt32LE(entries[i] ?? 0xffffffff, i * 4)
  }
  return sector
}

/** 大流：走 FAT 链 */
function buildRegularCfb(streamName: string, data: Buffer): Buffer {
  const streamSectors = Math.ceil(data.length / SECTOR)
  const fat: number[] = [FATSECT, ENDOFCHAIN]
  for (let i = 0; i < streamSectors; i++) {
    fat.push(i === streamSectors - 1 ? ENDOFCHAIN : 2 + i + 1)
  }

  const dir = Buffer.alloc(SECTOR)
  dirEntry('Root Entry', 5, ENDOFCHAIN, 0).copy(dir, 0)
  dirEntry(streamName, 2, 2, data.length).copy(dir, 128)

  const header = headerFor({ fatSectors: 1, firstDirSector: 1, firstMiniFatSector: ENDOFCHAIN, numMiniFatSectors: 0 })
  const sectors = [fatSector(fat), dir]
  for (let i = 0; i < streamSectors; i++) {
    const chunk = Buffer.alloc(SECTOR)
    data.copy(chunk, 0, i * SECTOR, Math.min((i + 1) * SECTOR, data.length))
    sectors.push(chunk)
  }
  return assemble(header, sectors)
}

/** 小流：走 miniFAT + 根目录 mini stream */
function buildMiniCfb(streamName: string, data: Buffer): Buffer {
  const miniSectors = Math.ceil(data.length / 64)
  const miniStreamSize = miniSectors * 64
  const miniStreamSectors = Math.ceil(miniStreamSize / SECTOR)

  const miniFat: number[] = []
  for (let i = 0; i < miniSectors; i++) miniFat.push(i === miniSectors - 1 ? ENDOFCHAIN : i + 1)

  const fat: number[] = [FATSECT, ENDOFCHAIN, ENDOFCHAIN]
  for (let i = 0; i < miniStreamSectors; i++) {
    fat.push(i === miniStreamSectors - 1 ? ENDOFCHAIN : 3 + i + 1)
  }

  const dir = Buffer.alloc(SECTOR)
  // 根目录项持有 mini stream，起始扇区是 3
  dirEntry('Root Entry', 5, 3, miniStreamSize).copy(dir, 0)
  // 小流的起始扇区是 **mini 扇区号**，从 0 开始
  dirEntry(streamName, 2, 0, data.length).copy(dir, 128)

  const header = headerFor({ fatSectors: 1, firstDirSector: 1, firstMiniFatSector: 2, numMiniFatSectors: 1 })
  const sectors: Buffer[] = [fatSector(fat), dir, fatSector(miniFat)]

  const miniStream = Buffer.alloc(miniStreamSectors * SECTOR)
  data.copy(miniStream, 0)
  for (let i = 0; i < miniStreamSectors; i++) {
    sectors.push(miniStream.subarray(i * SECTOR, (i + 1) * SECTOR))
  }
  return assemble(header, sectors)
}

test('detectKind：.ppt / .PPT 都识别成 PPT', () => {
  assert.equal(detectKind('chapter1.ppt'), 'PPT')
  assert.equal(detectKind('CHAPTER1.PPT'), 'PPT')
  assert.equal(detectKind('chapter1.pptx'), 'PPTX')
  assert.equal(detectKind('chapter1.pdf'), 'PDF')
})

test('大流（≥4096 字节）：按幻灯片分组抽文字', () => {
  const slides = Buffer.concat([
    slide('第一页：导数的定义'),
    slide('第二页：求导法则'),
    slide('第三页：复合函数'),
  ])
  // 填充到超过 mini stream 阈值，强制走 FAT 链
  const padded = Buffer.concat([slides, Buffer.alloc(5000, 0)])
  const file = buildRegularCfb('PowerPoint Document', padded)

  const { pages } = extractPpt(file)
  assert.equal(pages.length, 3, `应该抽出 3 页，实际 ${pages.length}`)
  assert.ok(pages[0]!.includes('导数的定义'))
  assert.ok(pages[1]!.includes('求导法则'))
  assert.ok(pages[2]!.includes('复合函数'))
})

test('小流（<4096 字节）：走 miniFAT 也能读出来', () => {
  const slides = Buffer.concat([slide('小课件第一页'), slide('小课件第二页')])
  assert.ok(slides.length < 4096)
  const file = buildMiniCfb('PowerPoint Document', slides)

  const { pages } = extractPpt(file)
  assert.equal(pages.length, 2, `mini stream 路径失败，实际 ${pages.length} 页`)
  assert.ok(pages[0]!.includes('小课件第一页'))
})

test('TextBytesAtom（单字节记录）也能抽出来', () => {
  const ascii = record(0x0fa8, Buffer.from('Legacy single byte text', 'latin1'))
  const file = buildRegularCfb('PowerPoint Document', Buffer.concat([record(0x03ee, ascii), Buffer.alloc(5000, 0)]))
  const { pages } = extractPpt(file)
  assert.ok(pages[0]!.includes('Legacy single byte text'))
})

test('没有任何文字时返回空数组（由调用方明确报错，不假装成功）', () => {
  const file = buildRegularCfb('PowerPoint Document', Buffer.concat([record(0x03e8, Buffer.alloc(0)), Buffer.alloc(5000, 0)]))
  assert.deepEqual(extractPpt(file).pages, [])
})

test('把 .pptx 改名成 .ppt → 明确报错并给出可照做的提示', () => {
  const notOle = Buffer.from('%PDF-1.4 not really a ppt', 'utf8')
  assert.throws(
    () => extractPpt(Buffer.concat([notOle, Buffer.alloc(600)])),
    /不是旧版 \.ppt 格式/,
  )
})

test('OLE2 里没有 PowerPoint Document 流 → 报出缺的是哪个流', () => {
  const file = buildRegularCfb('WordDocument', Buffer.concat([Buffer.from('hello'), Buffer.alloc(5000, 0)]))
  assert.throws(() => extractPpt(file), /找不到「PowerPoint Document」流/)
})
