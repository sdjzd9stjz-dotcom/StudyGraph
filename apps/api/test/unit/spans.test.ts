import assert from 'node:assert/strict'
import test from 'node:test'

import type { SpanRef } from '../../../../packages/contracts/src/index.ts'
import { createSpanResolver, verifySpan } from '../../src/spans/resolver.ts'

const PAGE_TEXT = '第一节 定积分的定义。若函数 f 在区间 [a,b] 上连续，则其定积分存在。'

const span = (patch: Partial<SpanRef> = {}): SpanRef => ({
  id: 'sp1',
  sourceId: 'src1',
  page: 3,
  charStart: 0,
  charEnd: 11,
  text: PAGE_TEXT.slice(0, 11),
  ...patch,
})

const pages = new Map<number, string>([[3, PAGE_TEXT]])

test('text 与页文本逐字符相等 → 通过', () => {
  assert.deepEqual(verifySpan(span(), pages), { ok: true })
})

test('text 与原文不符 → TEXT_MISMATCH（造假检测在这里）', () => {
  const result = verifySpan(span({ text: '第三节 定积分的定义。' }), pages)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'TEXT_MISMATCH')
})

test('charStart == charEnd → BAD_RANGE（零长度 span 无法高亮）', () => {
  const result = verifySpan(span({ charStart: 5, charEnd: 5, text: '' }), pages)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'BAD_RANGE')
})

test('charEnd 超出页长度 → BAD_RANGE', () => {
  const result = verifySpan(span({ charStart: 0, charEnd: PAGE_TEXT.length + 10 }), pages)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'BAD_RANGE')
})

test('页码在原文里不存在 → PAGE_MISSING', () => {
  const result = verifySpan(span({ page: 99 }), pages)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'PAGE_MISSING')
})

test('只有空白的 span 不能作为依据 → EMPTY_TEXT', () => {
  const result = verifySpan(span({ charStart: 0, charEnd: 1, text: ' ' }), new Map([[3, ' x']]))
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'EMPTY_TEXT')
})

test('resolver 会缓存校验结果，不重复取页文本', async () => {
  let loads = 0
  const resolver = createSpanResolver({
    loadSpan: async () => span(),
    loadPageText: async () => {
      loads += 1
      return PAGE_TEXT
    },
  })

  const first = await resolver.verify(span())
  const second = await resolver.verify(span())

  assert.deepEqual(first, { ok: true })
  assert.deepEqual(second, { ok: true })
  assert.equal(loads, 1, '同一 span 第二次校验不应再取页文本')
})

test('resolver 对缺失的页返回 PAGE_MISSING，而不是抛出', async () => {
  const resolver = createSpanResolver({
    loadSpan: async () => null,
    loadPageText: async () => undefined,
  })

  const result = await resolver.verify(span())
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'PAGE_MISSING')
})
