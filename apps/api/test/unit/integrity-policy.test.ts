import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyClaim } from '../../src/spans/claim-support.ts'
import { assessIntegrity } from '../../src/spans/integrity-policy.ts'

/**
 * 巡检分级（SG-SUP-011 §3.3 的 A–F 六组）。
 *
 * 这些用例直接跑判定函数（纯逻辑），数据库那一层的实测另见回报；
 * 环境不可用时，至少保证"分歧判定"本身是对的。
 */

const SPAN = '偶数是指能被 2 整除的整数。连续函数是指在区间上每一点都连续的函数。'

const classificationOf = (name: string, definition: string, quote: string) =>
  classifyClaim({ name, definition, quote, spanText: SPAN })

test('A. 自动 VERIFIED + 引文对 + T1 全过 → 保持', () => {
  const quote = '偶数是指能被 2 整除的整数'
  const verdict = assessIntegrity({ status: 'VERIFIED', reviewedBy: null }, classificationOf('偶数', quote, quote))
  assert.deepEqual(verdict, { keep: true, mode: 'AUTO_T1' })
})

test('B. 自动 VERIFIED + 引文对 + 定义无关（鲸鱼是行星）→ 降级 UNSUPPORTED_DEFINITION', () => {
  const quote = '偶数是指能被 2 整除的整数'
  const verdict = assessIntegrity(
    { status: 'VERIFIED', reviewedBy: null },
    classificationOf('鲸鱼', '鲸鱼是一种行星', quote),
  )
  assert.equal(verdict.keep, false)
  assert.equal(verdict.keep === false && verdict.reason, 'UNSUPPORTED_DEFINITION')
})

test('C. 人工 ACCEPT + 引文对 + 合理转述 → 保持', () => {
  const quote = '在区间上每一点都连续的函数'
  const verdict = assessIntegrity(
    { status: 'VERIFIED', reviewedBy: 'teacher-1' },
    classificationOf('连续函数', '连续函数是指在区间上每一点都连续的函数', quote),
  )
  assert.deepEqual(verdict, { keep: true, mode: 'HUMAN_APPROVED' })
})

test('D. 人工 ACCEPT + 引文伪造 → 降级', () => {
  const verdict = assessIntegrity(
    { status: 'VERIFIED', reviewedBy: 'teacher-1' },
    classificationOf('连续函数', '连续函数是一个函数', '这句话原文里没有'),
  )
  assert.equal(verdict.keep, false)
  assert.equal(verdict.keep === false && verdict.reason, 'TEXT_MISMATCH')
})

test('E. PENDING_REVIEW + 引文对 → 保持', () => {
  const quote = '在区间上每一点都连续的函数'
  const verdict = assessIntegrity(
    { status: 'PENDING_REVIEW', reviewedBy: null },
    classificationOf('连续函数', '连续函数是指在区间上每一点都连续的函数', quote),
  )
  assert.deepEqual(verdict, { keep: true, mode: 'PENDING' })
})

test('F. PENDING_REVIEW + 引文伪造 → 降级', () => {
  const verdict = assessIntegrity(
    { status: 'PENDING_REVIEW', reviewedBy: null },
    classificationOf('连续函数', '连续函数是个函数', '原文里没有这句'),
  )
  assert.equal(verdict.keep, false)
  assert.equal(verdict.keep === false && verdict.reason, 'TEXT_MISMATCH')
})
