// 生成受控 PPTX 测试材料（SG-SUP-014 收尾用）。
//
// 为什么不用手工改现有的十份课件：那十份是**冻结的验收材料**，改动它们等于
// 把历史证据换掉。这里从零造一份合法的 zip（中央目录 + deflate），
// 每一页的内容都是**有意设计**的：
//
//   P1 「指数函数练习目录」          → 纯标题，名称自带「指」字（旧 bug 的触发条件）
//   P2 指数函数的定义（含谓词）      → 应当 T1
//   P3 对数的换底公式（含谓词）      → 应当 T1/T2
//   P4 性质列表（无谓词、无定义句）  → 应当 T3，不许产卡
//
// 输出到 .tmp-backup/fixtures/（已 gitignore），不污染仓库。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'

const OUT_ENV = process.env.FIXTURE_OUT
const outDir = OUT_ENV ? path.dirname(OUT_ENV) : path.resolve('.tmp-backup/fixtures')
const outFile = OUT_ENV ?? path.join(outDir, 'controlled-012.pptx')

const escape = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function slideXml(lines) {
  const paragraphs = lines
    .map((line) => `<a:p><a:r><a:t>${escape(line)}</a:t></a:r></a:p>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
}

const slides = [
  ['指数函数练习目录'],
  [
    '指数函数是形如 y=a^x 的函数，其中 a 是大于零且不等于一的常数。',
    '指数函数的定义域是全体实数，值域是正实数。',
  ],
  [
    '对数的换底公式是指 log_a(b)=log_c(b)/log_c(a)，其中 c 是任意合法的底数。',
    '换底公式的作用是把任意底数的对数化为同一底数的比。',
  ],
  [
    '指数函数的性质',
    '对数函数的性质',
    '幂函数的性质',
  ],
]

const files = new Map()

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slides
  .map(
    (_, index) =>
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  )
  .join('')}</Types>`
files.set('[Content_Types].xml', contentTypes)

files.set(
  'ppt/presentation.xml',
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>${slides
    .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`)
    .join('')}</p:sldIdLst></p:presentation>`,
)

slides.forEach((lines, index) => {
  files.set(`ppt/slides/slide${index + 1}.xml`, slideXml(lines))
})

const now = new Date()
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff

const localParts = []
const centralParts = []
let offset = 0

for (const [name, content] of files) {
  const nameBytes = Buffer.from(name, 'utf8')
  const raw = Buffer.from(content, 'utf8')
  const deflated = deflateRawSync(raw)
  const useDeflate = deflated.length < raw.length
  const data = useDeflate ? deflated : raw
  const method = useDeflate ? 8 : 0
  const crc = crc32(raw)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(dosTime, 10)
  local.writeUInt16LE(dosDate, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(raw.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  local.writeUInt16LE(0, 28)
  localParts.push(local, nameBytes, data)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(method, 10)
  central.writeUInt16LE(dosTime, 12)
  central.writeUInt16LE(dosDate, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(raw.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(offset, 42)
  centralParts.push(central, nameBytes)

  offset += local.length + nameBytes.length + data.length
}

const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
const eocd = Buffer.alloc(22)
eocd.writeUInt32LE(0x06054b50, 0)
eocd.writeUInt16LE(0, 4)
eocd.writeUInt16LE(0, 6)
eocd.writeUInt16LE(files.size, 8)
eocd.writeUInt16LE(files.size, 10)
eocd.writeUInt32LE(centralSize, 12)
eocd.writeUInt32LE(offset, 16)
eocd.writeUInt16LE(0, 20)

mkdirSync(outDir, { recursive: true })
writeFileSync(outFile, Buffer.concat([...localParts, ...centralParts, eocd]))

console.log(
  JSON.stringify(
    { outFile, entries: [...files.keys()], slides: slides.length, expected: { T1: 2, T3: 2 } },
    null,
    2,
  ),
)

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
