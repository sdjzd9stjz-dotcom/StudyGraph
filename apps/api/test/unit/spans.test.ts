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

test('G1：负偏移在纯函数层就被拒（不依赖 Zod）', () => {
  const negativeStart = verifySpan(span({ charStart: -3, charEnd: 2, text: '第一节' }), pages)
  assert.equal(negativeStart.ok, false)
  assert.equal(negativeStart.ok === false && negativeStart.reason, 'BAD_RANGE')

  const negativeEnd = verifySpan(span({ charStart: 0, charEnd: -1, text: '' }), pages)
  assert.equal(negativeEnd.ok, false)
  assert.equal(negativeEnd.ok === false && negativeEnd.reason, 'BAD_RANGE')
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

test('A：原文变更后，同一 resolver 的第二次校验必须失败（SG-SUP-005 E05）', async () => {
  let page = 'abc'
  const shortSpan: SpanRef = { id: 's', sourceId: 'doc', page: 1, charStart: 0, charEnd: 1, text: 'a' }
  const resolver = createSpanResolver({
    loadSpan: async () => shortSpan,
    loadPageText: async () => page,
  })

  const first = await resolver.verify(shortSpan)
  assert.deepEqual(first, { ok: true })

  page = 'xyz' // 原文被改
  const second = await resolver.verify(shortSpan)

  assert.equal(second.ok, false, '原文变了还返回 ok，硬约束 1 就被击穿了')
  assert.equal(second.ok === false && second.reason, 'TEXT_MISMATCH')
})

test('A：提供源版本时，版本不变走缓存、版本一变必须重算', async () => {
  let version = 'v1'
  let page = 'abc'
  let pageLoads = 0
  const shortSpan: SpanRef = { id: 's2', sourceId: 'doc', page: 1, charStart: 0, charEnd: 1, text: 'a' }

  const resolver = createSpanResolver({
    loadSpan: async () => shortSpan,
    loadPageText: async () => {
      pageLoads += 1
      return page
    },
    loadSourceVersion: async () => version,
  })

  assert.deepEqual(await resolver.verify(shortSpan), { ok: true })
  assert.equal(pageLoads, 1)

  // 版本没变 → 命中缓存，不再读页文本
  assert.deepEqual(await resolver.verify(shortSpan), { ok: true })
  assert.equal(pageLoads, 1, '版本未变时应命中缓存')

  // 版本变了 → 必须重读并重算
  version = 'v2'
  page = 'xyz'
  const afterChange = await resolver.verify(shortSpan)
  assert.equal(afterChange.ok, false)
  assert.equal(pageLoads, 2)
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
