import assert from 'node:assert/strict'
import test from 'node:test'
import { splitSpanText } from '../../src/nodes/executors/chunk.ts'
import { summarizeArtifact } from '../../src/domain/artifact-text.ts'

test('默认切点正好落在数学斜体字符中间时，各片都能独立编码并还原原文', () => {
  const prefix = '数'.repeat(799)
  const original = prefix + '𝑑𝜒和𠮷😀\\u1234'
  const pieces = splitSpanText(original, 800)
  assert.deepEqual(pieces, [prefix + '𝑑', '𝜒和𠮷😀\\u1234'])
  for (const piece of pieces) assert.equal(Buffer.from(piece, 'utf8').toString('utf8'), piece)
  assert.equal(pieces.join(''), original)
})

test('长度 1、整除及小于上限时保留数学字符、标点和反斜杠', () => {
  const chars = ['𝑑', '𠮷', '😀', '。', '\\']
  assert.deepEqual(splitSpanText(chars.join(''), 1), chars)
  assert.deepEqual(splitSpanText('𝑑𠮷😀。', 2), ['𝑑𠮷', '😀。'])
  assert.deepEqual(splitSpanText('𝑑𠮷', 20), ['𝑑𠮷'])
  assert.deepEqual(splitSpanText('ABCDE', 2), ['AB', 'CD', 'E'])
  for (const invalid of [0, -1, NaN, 0.5]) assert.throws(() => splitSpanText('x', invalid), /正整数/)
})

test('画布切片摘要省略完整字符，不显示半个数学字母', () => {
  const prefix = '数'.repeat(79)
  const preview = summarizeArtifact('CHUNKS', { chunkSet: { chunks: [{ text: prefix + '𝑑x' }] } })
  assert.ok(preview.endsWith(prefix + '…'))
  assert.equal(Buffer.from(preview, 'utf8').toString('utf8'), preview)
})
