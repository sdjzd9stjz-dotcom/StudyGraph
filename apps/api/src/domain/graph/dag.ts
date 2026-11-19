/**
 * DAG 工具：下游收集、拓扑排序、环路检测。
 *
 * 为什么 M1 就要有它：上游改动 → 下游全链标 STALE（**不自动重跑**）是硬约束 2 的落点。
 *
 * ## stale 传播只沿 DERIVED_FROM（SG-SUP-002 §2.1 / P1-1）
 *
 * 三种边里，只有 DERIVED_FROM 意味着"我的产物是用你的产物算出来的"——那才叫数据依赖。
 *
 * - `CITES` 指向原文 span：上游节点重跑不会让引用失效；原文变没变由 `Source.checksum` 判定，
 *   属于溯源层的事，不该由节点图的 stale 传播承担。
 * - `PREREQUISITE` 是概念先修（学习路径顺序），不是数据流；沿它把下游判为 stale，
 *   会让"补一条先修边"这种纯知识操作触发整条加工链重算，既贵又错。
 *
 * 所以默认只走 DERIVED_FROM，与 `packages/db/sql/downstream.sql` 一致；
 * 需要看"所有连线关系"的地方（如画布高亮）显式传 `{ kinds: EDGE_KINDS }`。
 *
 * 纯函数与 SQL 的一致性由 `apps/api/test/integration/downstream-equivalence.test.ts`
 * 在真实 PG16 上比对，不靠人工保证。
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
  /** 只沿这些语义展开；默认只看 DERIVED_FROM（见文件头）。 */
  readonly kinds?: readonly EdgeKind[]
}

/** stale 传播的语义集合：只有派生关系构成加工依赖。 */
export const STALE_EDGE_KINDS = ['DERIVED_FROM'] as const

/** 全部三种语义，供画布高亮等"看关系"的场景显式使用。 */
export const ALL_EDGE_KINDS = EDGE_KINDS

export class CycleError extends Error {
  /** 真实环路径，首尾为同一节点，例如 ['A','B','A']。 */
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
  nodeIds?: readonly string[],
): Map<string, string[]> {
  const allowed = new Set(kinds)
  const known = nodeIds ? new Set(nodeIds) : undefined
  const adjacency = new Map<string, string[]>()

  for (const edge of edges) {
    if (!allowed.has(edge.kind)) continue
    const from = direction === 'downstream' ? edge.fromNodeId : edge.toNodeId
    const to = direction === 'downstream' ? edge.toNodeId : edge.fromNodeId
    if (known && (!known.has(from) || !known.has(to))) continue
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
  const adjacency = buildAdjacency(edges, options.kinds ?? STALE_EDGE_KINDS, direction)

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

/** DFS 回溯出**真实环路径**（首尾同一节点）。找不到环返回 undefined。 */
function findCycle(nodeIds: readonly string[], adjacency: Map<string, string[]>): string[] | undefined {
  const UNVISITED = 0
  const IN_STACK = 1
  const DONE = 2
  const state = new Map<string, number>()
  const stack: string[] = []

  const visit = (node: string): string[] | undefined => {
    state.set(node, IN_STACK)
    stack.push(node)

    for (const next of adjacency.get(node) ?? []) {
      const status = state.get(next) ?? UNVISITED
      if (status === IN_STACK) {
        const from = stack.indexOf(next)
        return [...stack.slice(from), next]
      }
      if (status === UNVISITED) {
        const found = visit(next)
        if (found) return found
      }
    }

    state.set(node, DONE)
    stack.pop()
    return undefined
  }

  for (const id of nodeIds) {
    if ((state.get(id) ?? UNVISITED) !== UNVISITED) continue
    const found = visit(id)
    if (found) return found
  }

  return undefined
}

/**
 * Kahn 拓扑排序。有环时抛 CycleError（带**真实环路径**，不是"排不动的节点集合"）。
 * 节点图必须是 DAG：DERIVED_FROM 成环意味着重放与溯源都不可能收敛。
 */
export function topoSort(
  nodeIds: readonly string[],
  edges: readonly EdgeLike[],
  options: TraverseOptions = {},
): string[] {
  const kinds = options.kinds ?? STALE_EDGE_KINDS
  const adjacency = buildAdjacency(edges, kinds, 'downstream', nodeIds)
  const indegree = new Map<string, number>()

  for (const id of nodeIds) indegree.set(id, 0)
  for (const targets of adjacency.values()) {
    for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1)
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
    const cycle = findCycle(nodeIds, adjacency)
    // 理论上必然能找到环；兜底仍给出"排不动的节点"，避免抛出一个没有信息的错误
    throw new CycleError(cycle ?? nodeIds.filter((id) => (indegree.get(id) ?? 0) > 0))
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
