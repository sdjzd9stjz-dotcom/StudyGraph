import assert from 'node:assert/strict'
import test from 'node:test'

import { CycleError, collectDownstream, collectUpstream, isAcyclic, topoSort } from '../../src/domain/graph/dag.ts'
import type { EdgeLike } from '../../src/domain/graph/dag.ts'

const derived = (fromNodeId: string, toNodeId: string): EdgeLike => ({
  fromNodeId,
  toNodeId,
  kind: 'DERIVED_FROM',
})

test('A→B→C：collectDownstream(A) 必须返回 [B, C]', () => {
  const edges = [derived('A', 'B'), derived('B', 'C')]
  const result = collectDownstream(edges, 'A')

  // 具体值比对（不是 toBeDefined）：监理要求能一眼看出拿到的是哪两个节点
  assert.deepEqual(result, ['B', 'C'])
  assert.deepEqual(result.sort(), ['B', 'C'].sort())
})

test('菱形 A→B、A→C、B→D、C→D：下游不重复', () => {
  const edges = [derived('A', 'B'), derived('A', 'C'), derived('B', 'D'), derived('C', 'D')]
  const result = collectDownstream(edges, 'A')

  assert.deepEqual(result.slice().sort(), ['B', 'C', 'D'])
  assert.equal(result.filter((id) => id === 'D').length, 1, 'D 只能出现一次')
})

test('成环 A→B→A 不会死循环，且不把起点当自己的下游', () => {
  const edges = [derived('A', 'B'), derived('B', 'A')]
  const result = collectDownstream(edges, 'A')

  assert.deepEqual(result, ['B'])
})

test('自环 A→A 直接忽略', () => {
  const edges = [derived('A', 'A')]
  assert.deepEqual(collectDownstream(edges, 'A'), [])
})

test('与外链无关的分支不串进来', () => {
  const edges = [derived('A', 'B'), derived('X', 'Y')]
  assert.deepEqual(collectDownstream(edges, 'A'), ['B'])
})

test('默认只沿三种语义全走；指定 kinds 后其它语义被忽略', () => {
  const edges: EdgeLike[] = [
    { fromNodeId: 'A', toNodeId: 'B', kind: 'DERIVED_FROM' },
    { fromNodeId: 'A', toNodeId: 'C', kind: 'CITES' },
  ]

  assert.deepEqual(collectDownstream(edges, 'A').slice().sort(), ['B', 'C'])
  assert.deepEqual(collectDownstream(edges, 'A', { kinds: ['DERIVED_FROM'] }), ['B'])
})

test('collectUpstream 是下游的反向：C 的上游是 A、B', () => {
  const edges = [derived('A', 'B'), derived('B', 'C')]
  assert.deepEqual(collectUpstream(edges, 'C').slice().sort(), ['A', 'B'])
})

test('拓扑排序把上游排在前面', () => {
  const edges = [derived('A', 'B'), derived('B', 'C')]
  assert.deepEqual(topoSort(['C', 'B', 'A'], edges), ['A', 'B', 'C'])
})

test('有环时 topoSort 抛 CycleError，并带上环上的节点', () => {
  const edges = [derived('A', 'B'), derived('B', 'C'), derived('C', 'A')]

  assert.throws(
    () => topoSort(['A', 'B', 'C'], edges),
    (error: unknown) => {
      assert.ok(error instanceof CycleError)
      assert.deepEqual(error.cycle.slice().sort(), ['A', 'B', 'C'])
      return true
    },
  )
})

test('isAcyclic 对链返回 true，对环返回 false', () => {
  assert.equal(isAcyclic(['A', 'B', 'C'], [derived('A', 'B'), derived('B', 'C')]), true)
  assert.equal(isAcyclic(['A', 'B'], [derived('A', 'B'), derived('B', 'A')]), false)
})

test('拓扑排序忽略不在节点集合里的悬空边', () => {
  const edges = [derived('A', 'Z')]
  assert.deepEqual(topoSort(['B', 'A'], edges), ['B', 'A'])
})
