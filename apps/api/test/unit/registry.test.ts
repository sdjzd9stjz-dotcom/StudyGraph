import assert from 'node:assert/strict'
import test from 'node:test'

import { AppError } from '../../src/lib/errors.ts'
import {
  PLANNED_PLAN,
  assertRegistryReady,
  getExecutor,
  hasExecutor,
  implementedTypes,
  registerExecutor,
  selfCheck,
} from '../../src/nodes/registry.ts'

test('自检：已实现 ∪ 计划 = 17，且没有问题项', () => {
  const report = selfCheck()
  assert.equal(report.unionSize, 17)
  assert.deepEqual(report.problems, [])
  assert.deepEqual(report.missingPlan, [])
  assert.equal(report.ok, true)
  assert.equal(report.implemented.length + report.planned.length, 17)
})

test('C：删掉一个计划项 → ok:false、problems 非空、且该类型不在 planned 里', () => {
  const saved = PLANNED_PLAN.SOURCE
  try {
    delete (PLANNED_PLAN as Record<string, string>).SOURCE
    const report = selfCheck()

    assert.equal(report.ok, false, '缺计划必须让自检失败')
    assert.ok(report.problems.length >= 1, 'problems 必须说明缺了什么')
    assert.equal(report.planned.includes('SOURCE'), false, 'planned 由计划表推导，删了就应消失')
    assert.deepEqual(report.missingPlan, ['SOURCE'])
  } finally {
    ;(PLANNED_PLAN as Record<string, string>).SOURCE = saved
  }

  // 恢复后必须重新通过（证明上面的失败来自计划缺失，而不是别的副作用）
  assert.equal(selfCheck().ok, true)
})

test('C：断言直接拦下未通过的自检（启动路径用它）', () => {
  const saved = PLANNED_PLAN.PAPER
  try {
    delete (PLANNED_PLAN as Record<string, string>).PAPER
    assert.throws(() => assertRegistryReady(), /执行器注册表自检未通过/)
  } finally {
    ;(PLANNED_PLAN as Record<string, string>).PAPER = saved
  }
  assert.doesNotThrow(() => assertRegistryReady())
})

test('每个类型都有计划里程碑（不能出现"没人负责"的节点）', () => {
  for (const type of Object.keys(PLANNED_PLAN)) {
    assert.ok(PLANNED_PLAN[type as keyof typeof PLANNED_PLAN], `${type} 缺少计划里程碑`)
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
