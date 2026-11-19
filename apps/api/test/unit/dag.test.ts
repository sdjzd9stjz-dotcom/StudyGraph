import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ALL_EDGE_KINDS,
  CycleError,
  STALE_EDGE_KINDS,
  collectDownstream,
  collectUpstream,
  isAcyclic,
  topoSort,
} from '../../src/domain/graph/dag.ts'
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
  assert.deepEqual(result.slice().sort(), ['B', 'C'].sort())
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

test('默认只沿 DERIVED_FROM：CITES / PREREQUISITE 不造成 stale（P1-1）', () => {
  const edges: EdgeLike[] = [
    { fromNodeId: 'A', toNodeId: 'B', kind: 'DERIVED_FROM' },
    { fromNodeId: 'A', toNodeId: 'C', kind: 'CITES' },
    { fromNodeId: 'A', toNodeId: 'D', kind: 'PREREQUISITE' },
  ]

  assert.deepEqual(collectDownstream(edges, 'A'), ['B'], '默认只有派生关系构成下游')

  // 想看全部连线关系时才显式传 ALL_EDGE_KINDS
  assert.deepEqual(collectDownstream(edges, 'A', { kinds: ALL_EDGE_KINDS }).slice().sort(), ['B', 'C', 'D'])
  assert.deepEqual(STALE_EDGE_KINDS, ['DERIVED_FROM'])
})

test('collectUpstream 同样是派生关系反向：C 的上游是 A、B', () => {
  const edges = [derived('A', 'B'), derived('B', 'C'), { fromNodeId: 'X', toNodeId: 'C', kind: 'CITES' } as EdgeLike]
  assert.deepEqual(collectUpstream(edges, 'C').slice().sort(), ['A', 'B'])
})

test('拓扑排序把上游排在前面', () => {
  const edges = [derived('A', 'B'), derived('B', 'C')]
  assert.deepEqual(topoSort(['C', 'B', 'A'], edges), ['A', 'B', 'C'])
})

test('拓扑排序忽略非派生边：补一条 PREREQUISITE 不改变顺序', () => {
  const edges: EdgeLike[] = [derived('A', 'B')]
  const withPrereq: EdgeLike[] = [...edges, { fromNodeId: 'B', toNodeId: 'A', kind: 'PREREQUISITE' }]
  assert.deepEqual(topoSort(['A', 'B'], withPrereq), ['A', 'B'])
})

test('有环时 topoSort 抛 CycleError，cycle 是真实环路径 A→B→C→A', () => {
  const edges = [derived('A', 'B'), derived('B', 'C'), derived('C', 'A')]

  assert.throws(
    () => topoSort(['A', 'B', 'C'], edges),
    (error: unknown) => {
      assert.ok(error instanceof CycleError)
      assert.equal(error.cycle[0], error.cycle[error.cycle.length - 1], '首尾必须是同一节点')
      assert.deepEqual(new Set(error.cycle), new Set(['A', 'B', 'C']))
      return true
    },
  )
})

test('P2-4：cycle 不含不在环上的节点（A→B→A 与 B→C 并存）', () => {
  const edges = [derived('A', 'B'), derived('B', 'A'), derived('B', 'C')]

  assert.throws(
    () => topoSort(['A', 'B', 'C'], edges),
    (error: unknown) => {
      assert.ok(error instanceof CycleError)
      // 环是 A↔B，DFS 从谁都可能出发，所以只断言形状：3 个点、首尾相同、集合为 {A,B}
      assert.equal(error.cycle.length, 3, `实际=${error.cycle.join('→')}`)
      assert.equal(error.cycle[0], error.cycle[2])
      assert.deepEqual(new Set(error.cycle), new Set(['A', 'B']))
      assert.equal(error.cycle.includes('C'), false, 'C 不在环上，不该出现在 cycle 里')
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
