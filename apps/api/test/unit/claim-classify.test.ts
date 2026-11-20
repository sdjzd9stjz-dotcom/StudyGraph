import assert from 'node:assert/strict'
import test from 'node:test'

import { REVIEW_MIN_BIGRAM_SIMILARITY } from '../../../../packages/contracts/src/index.ts'
import { bigramJaccard, classifyClaim } from '../../src/spans/claim-support.ts'

/**
 * 三档判定（SG-SUP-010 §1.3 + SG-SUP-011 §2.2）。
 *
 * 两条铁律：
 * 1. A1（引文在原文里）失败 → 一律 UNVERIFIED，没有例外。
 * 2. 谓词必须来自**名称之外**：名称自带的「指/等」不能当谓词，
 *    否则「指数函数练习目录」这种纯标题会进 T1。
 */

const SPAN =
  '连续函数：在区间上每一点都连续的函数称为该区间上的连续函数。' +
  '可去间断点是指改变或补充该点处的定义即可使其连续的点。' +
  '指数函数练习目录'

const classify = (name: string, definition: string, quote: string, spanText = SPAN) =>
  classifyClaim({ name, definition, quote, spanText })

test('T1：定义与引文逐字相同 → VERIFIED', () => {
  const quote = '可去间断点是指改变或补充该点处的定义即可使其连续的点'
  const result = classify('可去间断点', quote, quote)
  assert.equal(result.verdict, 'VERIFIED')
  assert.deepEqual(result.reasons, [])
})

test('T2：引文可查但定义是转述 → PENDING_REVIEW', () => {
  const quote = '在区间上每一点都连续的函数'
  const result = classify('连续函数', '连续函数是指在区间上每一点都连续的函数', quote)
  assert.equal(result.verdict, 'PENDING_REVIEW', `相似度 ${result.similarity}`)
  assert.ok(result.similarity >= REVIEW_MIN_BIGRAM_SIMILARITY)
})

test('A1 铁律：引文不在原文里 → UNVERIFIED，哪怕定义完全合理', () => {
  const result = classify('连续函数', '连续函数是指在区间上处处连续的函数', '连续函数在闭区间上必有最大值')
  assert.equal(result.verdict, 'UNVERIFIED')
  assert.deepEqual(result.reasons, ['A1_QUOTE_NOT_IN_SPAN'])
})

test('无引文 → UNVERIFIED（NO_QUOTE）', () => {
  const result = classify('连续函数', '连续函数是一种函数', '')
  assert.equal(result.verdict, 'UNVERIFIED')
  assert.deepEqual(result.reasons, ['NO_QUOTE'])
})

// ── SG-SUP-011 §2.3 六个回归用例 ─────────────────────────────────────────────

test('回归 1：「指数函数练习目录」（纯标题，名称自带「指」）→ T3', () => {
  const result = classify('指数函数', '指数函数练习目录', '指数函数练习目录')
  assert.equal(result.verdict, 'UNVERIFIED')
  assert.ok(result.reasons.includes('RESIDUAL_TOO_SHORT'))
  assert.ok(result.reasons.includes('NO_PREDICATE'))
})

test('回归 2：「反函数习题」（名称自带「反」，构造标题）→ T3', () => {
  const span = '反函数习题'
  const result = classify('反函数', '反函数习题', '反函数习题', span)
  assert.equal(result.verdict, 'UNVERIFIED')
  assert.ok(result.reasons.includes('RESIDUAL_TOO_SHORT'))
})

test('回归 3：「连续函数的定义」+ 原文有「连续函数是指…」→ T1/T2', () => {
  const span = '连续函数是指在区间上每一点都连续的函数。'
  const quote = '连续函数是指在区间上每一点都连续的函数'
  const result = classify('连续函数', quote, quote, span)
  assert.ok(['VERIFIED', 'PENDING_REVIEW'].includes(result.verdict), `实际 ${result.verdict}`)
})

test('回归 4：「等价无穷小替换法则」（名称含「等于」的邻字「等价」）→ T3', () => {
  const span = '等价无穷小替换法则'
  const result = classify('等价无穷小替换法则', '等价无穷小替换法则', '等价无穷小替换法则', span)
  assert.equal(result.verdict, 'UNVERIFIED')
})

test('回归 5：正常定义「在区间上每一点都连续的函数称为连续函数」→ T1/T2', () => {
  const span = '在区间上每一点都连续的函数称为连续函数。'
  const quote = '在区间上每一点都连续的函数称为连续函数'
  const result = classify('连续函数', quote, quote, span)
  assert.ok(['VERIFIED', 'PENDING_REVIEW'].includes(result.verdict), `实际 ${result.verdict}`)
})

test('回归 6：定义过短（长度比越界）→ T3', () => {
  const quote = '在区间上每一点都连续的函数称为该区间上的连续函数'
  const result = classify('连续函数', '连续函数是指连续', quote)
  assert.equal(result.verdict, 'UNVERIFIED')
})

test('bigram Jaccard：自己比自己 = 1，完全无关接近 0', () => {
  assert.equal(bigramJaccard('连续函数', '连续函数'), 1)
  assert.ok(bigramJaccard('连续函数', '矩阵的秩') < 0.1)
})
