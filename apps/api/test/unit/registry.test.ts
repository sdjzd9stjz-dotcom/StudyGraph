import assert from 'node:assert/strict'
import test from 'node:test'

import { NODE_TYPES } from '../../../../packages/contracts/src/node-types.ts'
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

test('自检：全部 NodeType 有执行器，计划表为空，没有问题项', () => {
  const report = selfCheck()
  assert.equal(report.unionSize, NODE_TYPES.length)
  assert.deepEqual(report.problems, [])
  assert.deepEqual(report.missingPlan, [])
  assert.equal(report.ok, true)

  // 这一条是重点：以前 implemented 只有 4 个，现在必须等于全部 17 个。
  // 如果有人把某个执行器从 index.ts 里摘掉，这里立刻红。
  assert.equal(report.implemented.length, NODE_TYPES.length)
  assert.deepEqual(report.implemented.slice().sort(), [...NODE_TYPES].sort())
  assert.deepEqual(report.planned, [], '计划表必须为空：没有"排了期但没做"的节点')
  assert.deepEqual(Object.keys(PLANNED_PLAN), [])
})

test('每个 NodeType 都必须能取到执行器，且类型自洽', () => {
  for (const type of NODE_TYPES) {
    assert.equal(hasExecutor(type), true, `${type} 没有执行器`)
    const executor = getExecutor(type)
    assert.equal(executor.type, type)
    // artifactKind / promptVersion 是落库必填项，空值会让 Run 写入出问题
    assert.equal(typeof executor.artifactKind, 'string')
    assert.ok(executor.artifactKind.length > 0, `${type} 的 artifactKind 为空`)
    assert.equal(typeof executor.promptVersion, 'string')
    assert.ok(executor.promptVersion.length > 0, `${type} 的 promptVersion 为空`)
  }
})

test('C：把一个已实现类型写进计划表 → ok:false（实现与计划不能重叠）', () => {
  const saved = PLANNED_PLAN.PREREQ
  try {
    ;(PLANNED_PLAN as Record<string, string>).PREREQ = 'M3'
    const report = selfCheck()

    assert.equal(report.ok, false, '已实现又出现在计划表里必须让自检失败')
    assert.ok(report.problems.some((problem) => problem.includes('PREREQ')))
  } finally {
    if (saved === undefined) delete (PLANNED_PLAN as Record<string, string>).PREREQ
    else (PLANNED_PLAN as Record<string, string>).PREREQ = saved
  }

  assert.equal(selfCheck().ok, true)
})

test('C：extra（计划表里出现 NODE_TYPES 之外的类型）必须被点名', () => {
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
  ;(PLANNED_PLAN as Record<string, string>).PAPER = 'M6'
  try {
    assert.throws(() => assertRegistryReady(), /执行器注册表自检未通过/)
  } finally {
    if (saved === undefined) delete (PLANNED_PLAN as Record<string, string>).PAPER
    else (PLANNED_PLAN as Record<string, string>).PAPER = saved
  }
  assert.doesNotThrow(() => assertRegistryReady())
})

test('调用不在 NODE_TYPES 之内的类型 → 501 EXECUTOR_NOT_IMPLEMENTED', () => {
  // 17 个都实现了，所以"未实现"这条路只能从 17 之外的类型走。
  // 这条仍要留：它保证 getExecutor 对未知输入不会返回 undefined。
  assert.throws(
    () => getExecutor('NOT_A_TYPE'),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.status, 501)
      assert.equal(error.code, 'EXECUTOR_NOT_IMPLEMENTED')
      return true
    },
  )
})

test('getExecutor 对任何类型都不会返回 undefined', () => {
  for (const type of ['NOT_A_TYPE', '', 'GATE', 'PAPER']) {
    // 已实现的返回执行器；未实现的抛错。两种都不是 undefined。
    let value: unknown
    assert.doesNotThrow(() => {
      try {
        value = getExecutor(type)
      } catch (error) {
        assert.ok(error instanceof AppError)
        value = error
      }
    })
    assert.notEqual(value, undefined)
  }
})

test('registerExecutor 拒绝 NODE_TYPES 之外的类型', () => {
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
    /不在 NodeType 列表之内/,
  )
})

test('registerExecutor 拒绝重复注册', () => {
  // 用一个 17 之内、但当前还没注册的类型来测——不能拿已注册的当靶子，
  // 那会在断言之前就撞上"重复注册"。
  assert.equal(hasExecutor('CARD'), true)
  const executor = {
    type: 'CARD',
    artifactKind: 'CHUNKS' as const,
    promptVersion: 'no-prompt',
    inputs: {},
    outputs: {},
    async run() {
      return { outputs: {}, usage: { tokensIn: 0, tokensOut: 0, cachedTokens: 0 } }
    },
  }
  assert.throws(() => registerExecutor(executor), /重复注册/)
  // 重复注册失败后，原执行器必须还在（不能被半覆盖）
  assert.equal(getExecutor('CARD').type, 'CARD')
})

test('implementedTypes 与 NODE_TYPES 完全一致（顺序无关）', () => {
  assert.deepEqual(implementedTypes().slice().sort(), [...NODE_TYPES].sort())
})
