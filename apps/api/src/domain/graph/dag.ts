/**
 * DAG 工具：下游收集、拓扑排序、环路检测。
 *
 * 为什么 M1 就要有它：上游改动 → 下游全链标 STALE（**不自动重跑**）是硬约束 2 的实现基础。
 * 等 M2 再补，执行器已经按"只改自己"写完了，改起来要动节点链路。
 *
 * 这里的纯函数版本与 packages/db/sql/downstream.sql 的递归 CTE 互为验证：
 * - 服务层单节点判断用纯函数（快、可单测）
 * - 批量/深链用 SQL（一次往返，不把全图拉进内存）
 */
// M1 阶段没有构建产物，Node 又禁止在 node_modules 里做类型剥离（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），
// 所以这里用相对路径直连 contracts 源码。M2 引入 tsc 构建后改回 `@studygraph/contracts`。
import type { EdgeKind } from '../../../../../packages/contracts/src/index.ts'
import { EDGE_KINDS } from '../../../../../packages/contracts/src/index.ts'

export interface EdgeLike {
  readonly fromNodeId: string
  readonly toNodeId: string
  readonly kind: EdgeKind
}

export interface TraverseOptions {
  /** 只沿这些语义展开；默认三种全走。 */
  readonly kinds?: readonly EdgeKind[]
}

export class CycleError extends Error {
  readonly cycle: readonly string[]

  constructor(cycle: readonly string[]) {
    super(`节点图存在环：${cycle.join(' → ')}`)
    this.name = 'CycleError'
    this.cycle = cycle
  }
}

function buildAdjacency(
  edges: readonly EdgeLike[],
  kinds: readonly EdgeKind[],
  direction: 'downstream' | 'upstream',
): Map<string, string[]> {
  const allowed = new Set(kinds)
  const adjacency = new Map<string, string[]>()

  for (const edge of edges) {
    if (!allowed.has(edge.kind)) continue
    const from = direction === 'downstream' ? edge.fromNodeId : edge.toNodeId
    const to = direction === 'downstream' ? edge.toNodeId : edge.fromNodeId
    const bucket = adjacency.get(from)
    if (bucket) bucket.push(to)
    else adjacency.set(from, [to])
  }

  return adjacency
}

function traverse(
  edges: readonly EdgeLike[],
  startNodeId: string,
  direction: 'downstream' | 'upstream',
  options: TraverseOptions,
): string[] {
  const adjacency = buildAdjacency(edges, options.kinds ?? EDGE_KINDS, direction)

  // visited 一开始就含起点：既避免自环重复，也让 A→B→A 这类环停下来
  const visited = new Set<string>([startNodeId])
  const collected: string[] = []
  const queue: string[] = [startNodeId]

  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) continue
      visited.add(next)
      collected.push(next)
      queue.push(next)
    }
  }

  return collected
}

/**
 * 收集全部下游节点（不含起点本身）。
 * 造 A→B→C 时，collectDownstream(A) 必须是 [B, C]。
 */
export function collectDownstream(
  edges: readonly EdgeLike[],
  startNodeId: string,
  options: TraverseOptions = {},
): string[] {
  return traverse(edges, startNodeId, 'downstream', options)
}

/** 收集全部上游节点（不含起点本身），用于"这张卡是从哪来的"。 */
export function collectUpstream(
  edges: readonly EdgeLike[],
  startNodeId: string,
  options: TraverseOptions = {},
): string[] {
  return traverse(edges, startNodeId, 'upstream', options)
}

/**
 * Kahn 拓扑排序。有环时抛 CycleError（带环上的节点序列）。
 * 节点图必须是 DAG：DERIVED_FROM 成环意味着重放与溯源都不可能收敛。
 */
export function topoSort(
  nodeIds: readonly string[],
  edges: readonly EdgeLike[],
  options: TraverseOptions = {},
): string[] {
  const allowed = new Set(options.kinds ?? EDGE_KINDS)
  const indegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()

  for (const id of nodeIds) {
    indegree.set(id, 0)
  }

  for (const edge of edges) {
    if (!allowed.has(edge.kind)) continue
    if (!indegree.has(edge.fromNodeId) || !indegree.has(edge.toNodeId)) continue
    const bucket = adjacency.get(edge.fromNodeId)
    if (bucket) bucket.push(edge.toNodeId)
    else adjacency.set(edge.fromNodeId, [edge.toNodeId])
    indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) ?? 0) + 1)
  }

  const ready = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0)
  const sorted: string[] = []

  while (ready.length > 0) {
    const current = ready.shift() as string
    sorted.push(current)
    for (const next of adjacency.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1
      indegree.set(next, remaining)
      if (remaining === 0) ready.push(next)
    }
  }

  if (sorted.length !== nodeIds.length) {
    const stuck = nodeIds.filter((id) => (indegree.get(id) ?? 0) > 0)
    throw new CycleError(stuck)
  }

  return sorted
}

/** 无环即合法 DAG。 */
export function isAcyclic(nodeIds: readonly string[], edges: readonly EdgeLike[]): boolean {
  try {
    topoSort(nodeIds, edges)
    return true
  } catch (error) {
    if (error instanceof CycleError) return false
    throw error
  }
}
