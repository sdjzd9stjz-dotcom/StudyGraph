import assert from 'node:assert/strict'
import test from 'node:test'

import { typesFromPrompt } from '../../src/nodes/executors/quiz.ts'

/**
 * 题型约束。
 *
 * 真实反馈：用户在出题节点的提示词里写「要求是证明题，可涉及到线性空间的综合考察」，
 * 界面显示「出题 5 道」，点进去全是计算题（"矩阵 A 有 7 列，且 r(A)=4…"）。
 *
 * 根因有两层：
 *   1. 题型只从参数栏 `params.types` 取，提示词里的"证明题"完全没被当成约束
 *   2. 即使模型返回了别的题型，代码也照收 —— 没有任何校验
 *
 * 这里守的是第一层：把提示词里的题型要求读出来。
 */

test('提示词里写"证明题" → 推出 PROOF', () => {
  const types = typesFromPrompt('帮我生成几道有关子空间的相关问题，要求是证明题，可涉及到线性空间的综合考察')
  assert.deepEqual(types, ['PROOF'])
})

test('多种题型同时出现时都要保留', () => {
  const types = typesFromPrompt('出 3 道选择题和 2 道填空题')
  assert.ok(types.includes('SINGLE_CHOICE'))
  assert.ok(types.includes('FILL_BLANK'))
})

test('否定句不算要求："不要证明题" 不能推出 PROOF', () => {
  assert.deepEqual(typesFromPrompt('不要出证明题，出计算题'), ['COMPUTATION'])
  assert.deepEqual(typesFromPrompt('别出选择题'), [])
})

test('没有题型字样 → 空数组（退化成不限制，不瞎猜）', () => {
  assert.deepEqual(typesFromPrompt('帮我出几道题，难度 4'), [])
  assert.deepEqual(typesFromPrompt(''), [])
})

test('简答 / 判断 / 单选 / 多选 都能识别', () => {
  assert.deepEqual(typesFromPrompt('简答题'), ['SHORT_ANSWER'])
  assert.deepEqual(typesFromPrompt('判断题'), ['TRUE_FALSE'])
  assert.deepEqual(typesFromPrompt('单选题'), ['SINGLE_CHOICE'])
  assert.deepEqual(typesFromPrompt('多选题'), ['MULTI_CHOICE'])
})
