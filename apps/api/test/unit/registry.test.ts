import assert from 'node:assert/strict'
import test from 'node:test'

import { AppError } from '../../src/lib/errors.ts'
import { registerBuiltinExecutors } from '../../src/nodes/executors/index.ts'
import {
  PLANNED_PLAN,
  assertRegistryReady,
  getExecutor,
  hasExecutor,
  implementedTypes,
  registerExecutor,
  selfCheck,
} from '../../src/nodes/registry.ts'

// 模拟启动路径：注册内置执行器后再自检
registerBuiltinExecutors()

test('自检：已实现 ∪ 计划 = 17，且没有问题项', () => {
  const report = selfCheck()
  assert.equal(report.unionSize, 17)
  assert.deepEqual(report.problems, [])
  assert.deepEqual(report.missingPlan, [])
  assert.equal(report.ok, true)
  assert.equal(report.implemented.length + report.planned.length, 17)
  assert.deepEqual(report.implemented.slice().sort(), ['CARD', 'CHUNK', 'EXTRACT', 'SOURCE'])
})

test('C：删掉一个未实现的计划项 → ok:false、该类型进 missingPlan、且不在 planned 里', () => {
  const saved = PLANNED_PLAN.PREREQ
  try {
    delete (PLANNED_PLAN as Record<string, string>).PREREQ
    const report = selfCheck()

    assert.equal(report.ok, false, '缺计划必须让自检失败')
    assert.ok(report.problems.length >= 1)
    assert.equal(report.planned.includes('PREREQ'), false)
    assert.deepEqual(report.missingPlan, ['PREREQ'])
  } finally {
    ;(PLANNED_PLAN as Record<string, string>).PREREQ = saved as string
  }

  assert.equal(selfCheck().ok, true)
})

test('C：extra（计划表里出现 17 之外的类型）必须被点名', () => {
  const saved = (PLANNED_PLAN as Record<string, string>).OUTSIDE
  ;(PLANNED_PLAN as Record<string, string>).OUTSIDE = 'M2'
  try {
    const report = selfCheck()
    assert.equal(report.ok, false)
    assert.ok(report.problems.some((problem) => problem.includes('OUTSIDE')))
  } finally {
    if (saved === undefined) delete (PLANNED_PLAN as Record<string, string>).OUTSIDE
    else (PLANNED_PLAN as Record<string, string>).OUTSIDE = saved
  }
  assert.equal(selfCheck().ok, true)
})

test('C：断言直接拦下未通过的自检（启动路径用它）', () => {
  const saved = PLANNED_PLAN.PAPER
  try {
    delete (PLANNED_PLAN as Record<string, string>).PAPER
    assert.throws(() => assertRegistryReady(), /执行器注册表自检未通过/)
  } finally {
    ;(PLANNED_PLAN as Record<string, string>).PAPER = saved as string
  }
  assert.doesNotThrow(() => assertRegistryReady())
})

test('已实现的节点必须能从注册表取到执行器', () => {
  for (const type of ['SOURCE', 'CHUNK', 'EXTRACT', 'CARD']) {
    assert.equal(hasExecutor(type), true)
    assert.equal(getExecutor(type).type, type)
  }
})

test('调用未实现的节点 → 501 EXECUTOR_NOT_IMPLEMENTED，且带计划里程碑', () => {
  assert.equal(hasExecutor('PREREQ'), false)

  assert.throws(
    () => getExecutor('PREREQ'),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.status, 501)
      assert.equal(error.code, 'EXECUTOR_NOT_IMPLEMENTED')
      assert.equal(error.details?.plan, 'M3')
      return true
    },
  )
})

test('未实现的节点不会返回 undefined（否则上层会把它当成功）', () => {
  for (const type of ['PREREQ', 'PAPER', 'GATE']) {
    assert.throws(() => getExecutor(type), (error: unknown) => error instanceof AppError)
  }
})

test('registerExecutor 拒绝 17 个之外的类型', () => {
  assert.throws(
    () =>
      registerExecutor({
        type: 'NOT_A_NODE',
        artifactKind: 'CHUNKS',
        promptVersion: 'no-prompt',
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
    type: 'PREREQ',
    artifactKind: 'CHUNKS',
    promptVersion: 'no-prompt',
    inputs: {},
    outputs: {},
    async run() {
      return { outputs: {}, usage: { tokensIn: 0, tokensOut: 0, cachedTokens: 0 } }
    },
  }

  registerExecutor(executor)
  assert.equal(hasExecutor('CARD'), true)
  assert.throws(() => registerExecutor(executor), /重复注册/)
})
