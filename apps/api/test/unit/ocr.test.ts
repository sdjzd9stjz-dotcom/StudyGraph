import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateSync } from 'node:zlib'

import { createCanvas } from '@napi-rs/canvas'

import { normalizeOcrText, ocrPdf } from '../../src/storage/pdf-ocr.ts'

/**
 * 扫描件 OCR。
 *
 * 这套东西的错误代价很高：OCR 是在**猜**字。所以测试分两层：
 *   1. 收拾输出的规则（中文之间不该留空格）—— 纯函数，必须精确
 *   2. 真的把一张"只有图片"的 PDF 识别出来 —— 证明渲染 + 识别这条链能通
 *
 * 第二层会真的跑 OCR（约 1–3 秒），值得：这条路一旦坏，
 * 界面上只会显示"识别失败"，没人知道是渲染坏了还是语言包没带上。
 */

test('OCR 输出收拾：中文之间的空格要去掉，中英之间的保留', () => {
  // tesseract 会把每个汉字之间插空格，那不是原文
  assert.equal(normalizeOcrText('导 数 与 微 分'), '导数与微分')
  // 英文与数字不能被粘在一起
  assert.equal(normalizeOcrText('f(x) = x^2 的 导 数'), 'f(x) = x^2 的导数')
  // 空行压缩，首尾去空白
  assert.equal(normalizeOcrText('\n\n第一行\n\n\n\n第二行\n'), '第一行\n\n第二行')
})

/** 造一份"纯图片 PDF"：整页是一张位图，没有任何文字层 */
function buildImageOnlyPdf(text: string): Buffer {
  const W = 900
  const H = 240
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#111111'
  ctx.font = '52px "Microsoft YaHei", sans-serif'
  ctx.fillText(text, 40, 150)

  const rgba = ctx.getImageData(0, 0, W, H).data
  const rgb = Buffer.alloc(W * H * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]!
    rgb[j + 1] = rgba[i + 1]!
    rgb[j + 2] = rgba[i + 2]!
  }
  const image = deflateSync(rgb)

  const imageObject = Buffer.concat([
    Buffer.from(
      `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`,
    ),
    image,
    Buffer.from('\nendstream\nendobj\n'),
  ])

  const bodies: Record<number, Buffer> = {
    1: Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
    2: Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
    3: Buffer.from(
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
    ),
    4: imageObject,
    5: Buffer.from(`5 0 obj\n<< /Length 44 >>\nstream\nq ${W} 0 0 ${H} 0 0 cm /Im0 Do Q\nendstream\nendobj\n`),
  }

  // 逐个写对象并记下真实偏移，最后写 xref —— 偏移错一位 PDF 就打不开
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  let cursor = parts[0]!.length
  const offsets: Record<number, number> = {}
  for (const number of [1, 2, 3, 4, 5]) {
    offsets[number] = cursor
    parts.push(bodies[number]!)
    cursor += bodies[number]!.length
  }

  parts.push(
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n` +
        [1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('') +
        `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`,
    ),
  )
  return Buffer.concat(parts)
}

test('纯图片 PDF：能识别出页面上的文字', async () => {
  const pdf = buildImageOnlyPdf('导数与微分 2026')
  const outcome = await ocrPdf(pdf)

  assert.equal(outcome.pages.length, 1, '一页的 PDF 应该识别出一页')
  const text = outcome.pages[0]!.text
  assert.ok(text.length > 0, 'OCR 没有返回任何文字')

  // 中文识别可能有个别错字（这很正常），但数字与「导数」这种高频词应该认得出来
  assert.ok(/2026/.test(text), `没识别出 2026，实际：${JSON.stringify(text)}`)
  assert.ok(text.includes('导数'), `没识别出「导数」，实际：${JSON.stringify(text)}`)
  assert.ok(outcome.confidence > 50, `置信度偏低：${outcome.confidence}`)
})
