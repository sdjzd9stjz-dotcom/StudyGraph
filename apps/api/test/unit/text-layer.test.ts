import assert from 'node:assert/strict'
import test from 'node:test'

import { TEXT_LAYER } from '../../../../packages/contracts/src/index.ts'
import { assessTextLayer } from '../../src/storage/text-layer.ts'

/**
 * 文字层可用性闸门（SG-SUP-008 §2.3）。
 *
 * 用真实材料的形状校准：261 页里 30 页零星乱码必须被拦；
 * 32 页里 18 页有效（14 页纯图）必须放行。
 */

const gibberishPages = [
  '⾃ 整 有理实',
  "XEX 唯⼀yEY",
  'i',
  "苦 tO'P 1时⼀⼀an Hit it 六71⼗ it it ⼥ ⼥⼗平 ⼗合 ⼀⼆1⼗1⼗ 1t.i.tl",
  'féiidx⼆fed et州品贸品然品poTikxi cl u l',
  'f x 4inx 1 dX19sint dtloXhintdtFc sinx2',
]

function makePages(total: number, texts: string[]) {
  const pages = Array.from({ length: total }, (_, index) => ({ page: index + 1, text: '' }))
  texts.forEach((text, index) => {
    if (pages[index]) pages[index] = { page: index + 1, text }
  })
  return pages
}

test('标准 A：261 页里只有 30 页零星乱码 → 不可用（数学分析的形状）', () => {
  // 真实文件里既有整页乱码，也有大量单字符页（i / n / ⼀）
  const texts: string[] = []
  for (let i = 0; i < 30; i++) {
    texts.push(i % 2 === 0 ? gibberishPages[i % gibberishPages.length]! : ['i', 'n', '⼀'][i % 3]!)
  }
  const assessment = assessTextLayer(makePages(261, texts))

  assert.equal(assessment.usable, false)
  assert.ok(assessment.effectiveRatio < TEXT_LAYER.minEffectivePageRatio)
  assert.ok(
    assessment.signals.length >= TEXT_LAYER.minGibberishSignals,
    `乱码特征应至少两条，实际：${assessment.signals.join(' / ')}`,
  )
})

test('标准 A：32 页里 18 页有效、14 页纯图 → 可用（ch3-4 的形状，不能误杀）', () => {
  const texts = Array.from(
    { length: 18 },
    (_, i) => `定积分的定义：若函数在区间 [a,b] 上连续，则其定积分存在。第 ${i} 页`,
  )
  const assessment = assessTextLayer(makePages(32, texts))

  assert.equal(assessment.usable, true)
  assert.equal(assessment.effectivePages, 18)
  assert.ok(assessment.effectiveRatio > TEXT_LAYER.minEffectivePageRatio)
})

test('标准 B-1：康熙部首占比过高 → 记一条特征', () => {
  const text = '⼀⼆⼥⼗⽉⾃'.repeat(3) + '正常文字'
  const assessment = assessTextLayer(makePages(5, [text, text, text, text, text]))

  assert.ok(assessment.kangxiRatio > TEXT_LAYER.maxKangxiRatio)
  assert.ok(assessment.signals.some((signal) => signal.includes('康熙部首')))
})

test('标准 B-2：无元音拉丁串占多数 → 记一条特征', () => {
  const text = 'bcdfg hjklm npqrs tvwxz bcdfg hjklm npqrs tvwxz 定义'
  const assessment = assessTextLayer(makePages(5, [text, text, text, text, text]))

  assert.ok(assessment.vowelLessLatinRatio > TEXT_LAYER.maxVowelLessLatinRatio)
  assert.ok(assessment.signals.some((signal) => signal.includes('无元音')))
})

test('标准 B-3：单字符页占比过高 → 记一条特征', () => {
  const texts = ['i', 'n', '0', '⼀', 'x', '定积分的定义与性质说明文本内容足够长']
  const assessment = assessTextLayer(makePages(6, texts))

  assert.ok(assessment.singleCharPageRatio > TEXT_LAYER.maxSingleCharPageRatio)
  assert.ok(assessment.signals.some((signal) => signal.includes('单字符页')))
})

test('干净材料：乱码特征 0 条、有效页占比高 → 可用', () => {
  const texts = Array.from(
    { length: 10 },
    () => '线性代数中，矩阵的秩等于其非零子式的最高阶数，这是判定秩的基本方法。',
  )
  const assessment = assessTextLayer(makePages(10, texts))

  assert.equal(assessment.usable, true)
  assert.equal(assessment.signals.length, 0)
})
