import assert from 'node:assert/strict'
import test from 'node:test'

import { orderByDependency } from '../lib/run-order.ts'

/**
 * 「按依赖顺序运行选中的节点」（用户 2026-11-24 要求）。
 *
 * 顺序错了的后果不是报错，而是**下游拿到空的上游产物**，
 * 跑完显示"成功"但内容是空的 —— 比直接失败更难排查。
 */

const edge = (source: string, target: string) => ({ source, target })

test('一条链：上游一定排在下游前面', () => {
  const { ordered } = orderByDependency(['c', 'b', 'a'], [edge('a', 'b'), edge('b', 'c')])
  assert.deepEqual(ordered, ['a', 'b', 'c'])
})

test('分叉再合流：两条支路都在汇合点之前', () => {
  const { ordered } = orderByDependency(
    ['merge', 'left', 'right', 'root'],
    [edge('root', 'left'), edge('root', 'right'), edge('left', 'merge'), edge('right', 'merge')],
  )
  assert.equal(ordered.indexOf('root'), 0)
  assert.ok(ordered.indexOf('left') < ordered.indexOf('merge'))
  assert.ok(ordered.indexOf('right') < ordered.indexOf('merge'))
  assert.equal(ordered.at(-1), 'merge')
})

test('只排选中的：没选中的节点不会插进来', () => {
  const { ordered } = orderByDependency(['b', 'c'], [edge('a', 'b'), edge('b', 'c')])
  assert.deepEqual(ordered.sort(), ['b', 'c'])
  assert.ok(!ordered.includes('a'))
})

test('互不相关的节点：保持用户选中顺序（结果稳定）', () => {
  const first = orderByDependency(['x', 'y', 'z'], [])
  const second = orderByDependency(['x', 'y', 'z'], [])
  assert.deepEqual(first.ordered, ['x', 'y', 'z'])
  assert.deepEqual(second.ordered, first.ordered, '两次结果必须一致，否则指纹与缓存会抖')
})

test('有环不报错：环上的节点仍然返回，并单独标出来', () => {
  const { ordered, cyclic } = orderByDependency(['a', 'b'], [edge('a', 'b'), edge('b', 'a')])
  assert.deepEqual(ordered.sort(), ['a', 'b'])
  assert.deepEqual(cyclic.sort(), ['a', 'b'])
})

test('自环不影响排序', () => {
  const { ordered, cyclic } = orderByDependency(['a', 'b'], [edge('a', 'a'), edge('a', 'b')])
  assert.deepEqual(ordered, ['a', 'b'])
  assert.deepEqual(cyclic, [])
})

test('空选择返回空结果', () => {
  assert.deepEqual(orderByDependency([], [edge('a', 'b')]), { ordered: [], cyclic: [] })
})
