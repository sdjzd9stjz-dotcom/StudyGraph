import assert from 'node:assert/strict'
import test from 'node:test'

import { REVIEW_MIN_BIGRAM_SIMILARITY } from '../../../../packages/contracts/src/index.ts'
import { bigramJaccard, classifyClaim } from '../../src/spans/claim-support.ts'

/**
 * 三档判定（SG-SUP-010 §1.3）。
 *
 * 铁律：A1（引文在原文里）失败 → 一律 UNVERIFIED，没有例外。
 * T2 只是"定义不是原文的措辞"，不是"引文可以编"。
 */

const SPAN =
  '连续函数：在区间上每一点都连续的函数，称为该区间上的连续函数。' +
  '可去间断点是指改变或补充该点处的定义即可使其连续的点。'

test('T1：定义与引文逐字相同 → VERIFIED', () => {
  // T1 要求 definition.trim() === quote，所以引文本身必须含名称与谓词
  const quote = '可去间断点是指改变或补充该点处的定义即可使其连续的点'
  const result = classifyClaim({
    name: '可去间断点',
    definition: quote,
    quote,
    spanText: SPAN,
  })
  assert.equal(result.verdict, 'VERIFIED')
  assert.deepEqual(result.reasons, [])
})

test('T2：引文可查但定义是转述 → PENDING_REVIEW', () => {
  const quote = '在区间上每一点都连续的函数'
  const result = classifyClaim({
    name: '连续函数',
    definition: '连续函数是指在区间上每一点都连续的函数',
    quote,
    spanText: SPAN,
  })
  assert.equal(result.verdict, 'PENDING_REVIEW', `相似度 ${result.similarity}`)
  assert.ok(result.similarity >= REVIEW_MIN_BIGRAM_SIMILARITY)
})

test('A1 铁律：引文不在原文里 → UNVERIFIED，哪怕定义完全合理', () => {
  const result = classifyClaim({
    name: '连续函数',
    definition: '连续函数是指在区间上处处连续的函数',
    quote: '连续函数在闭区间上必有最大值', // 原文里没有这句
    spanText: SPAN,
  })
  assert.equal(result.verdict, 'UNVERIFIED')
  assert.deepEqual(result.reasons, ['A1_QUOTE_NOT_IN_SPAN'])
})

test('无引文 → UNVERIFIED（NO_QUOTE）', () => {
  const result = classifyClaim({ name: '连续函数', definition: '连续函数是一种函数', quote: '', spanText: SPAN })
  assert.equal(result.verdict, 'UNVERIFIED')
  assert.deepEqual(result.reasons, ['NO_QUOTE'])
})

test('标题式文本（名称不在定义里 / 没有谓词）→ UNVERIFIED', () => {
  const quote = '第三章 连续函数'
  const noPredicate = classifyClaim({
    name: '连续函数',
    definition: '连续函数 第三章',
    quote,
    spanText: '第三章 连续函数',
  })
  assert.equal(noPredicate.verdict, 'UNVERIFIED')
  assert.ok(noPredicate.reasons.includes('NO_PREDICATE'))
})

test('定义过短（长度比 < 0.5）→ UNVERIFIED，原因是 LENGTH_RATIO_OUT_OF_RANGE', () => {
  const quote = '在区间上每一点都连续的函数，称为该区间上的连续函数'
  const result = classifyClaim({
    name: '连续',
    definition: '连续是指连续',
    quote,
    spanText: SPAN,
  })
  assert.equal(result.verdict, 'UNVERIFIED')
  assert.ok(result.reasons.includes('LENGTH_RATIO_OUT_OF_RANGE') || result.reasons.includes('BELOW_SIMILARITY'))
})

test('bigram Jaccard：自己比自己 = 1，完全无关接近 0', () => {
  assert.equal(bigramJaccard('连续函数', '连续函数'), 1)
  assert.ok(bigramJaccard('连续函数', '矩阵的秩') < 0.1)
})
