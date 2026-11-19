import assert from 'node:assert/strict'
import test from 'node:test'

import { AppError } from '../../src/lib/errors.ts'
import { PLANNED_PLAN, getExecutor, hasExecutor, implementedTypes, registerExecutor, selfCheck } from '../../src/nodes/registry.ts'

test('自检：已实现 ∪ 计划 = 17，且没有问题项', () => {
  const report = selfCheck()
  assert.equal(report.unionSize, 17)
  assert.deepEqual(report.problems, [])
  assert.equal(report.ok, true)
  assert.equal(report.implemented.length + report.planned.length, 17)
})

test('每个类型都有计划里程碑（不能出现"没人负责"的节点）', () => {
  const report = selfCheck()
  for (const type of [...report.implemented, ...report.planned]) {
    assert.ok(PLANNED_PLAN[type], `${type} 缺少计划里程碑`)
  }
})

test('调用未实现的节点 → 501 EXECUTOR_NOT_IMPLEMENTED，且带计划里程碑', () => {
  assert.equal(hasExecutor('SOURCE'), false)

  assert.throws(
    () => getExecutor('SOURCE'),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.status, 501)
      assert.equal(error.code, 'EXECUTOR_NOT_IMPLEMENTED')
      assert.equal(error.details?.plan, 'M2')
      return true
    },
  )
})

test('未实现的节点不会返回 undefined（否则上层会把它当成功）', () => {
  for (const type of ['CHUNK', 'EXTRACT', 'CARD', 'PAPER']) {
    assert.throws(() => getExecutor(type), (error: unknown) => error instanceof AppError)
  }
})

test('registerExecutor 拒绝 17 个之外的类型', () => {
  assert.throws(
    () =>
      registerExecutor({
        type: 'NOT_A_NODE',
        inputs: {},
        outputs: {},
        async run() {
          return { outputs: {}, usage: { tokensIn: 0, tokensOut: 0, cachedTokens: 0 } }
        },
      }),
    /不在 17 个 NodeType 之内/,
  )
})

test('registerExecutor 拒绝重复注册', () => {
  const executor = {
    type: 'SOURCE',
    inputs: {},
    outputs: {},
    async run() {
      return { outputs: {}, usage: { tokensIn: 0, tokensOut: 0, cachedTokens: 0 } }
    },
  }

  registerExecutor(executor)
  assert.equal(hasExecutor('SOURCE'), true)
  assert.throws(() => registerExecutor(executor), /重复注册/)
  assert.deepEqual(implementedTypes(), ['SOURCE'])
})
