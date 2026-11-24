/**
 * 画布上的批量操作顺序（纯函数，不碰 React）。
 *
 * 用户 2026-11-24 要求：「选中多个节点时，右键可以按依赖顺序运行所有节点」。
 *
 * 为什么要排序而不是按选中顺序跑：下游节点必须等上游产物就绪才能跑，
 * 否则它拿到的是旧产物（甚至没有产物）—— 跑完看起来"成功了"，
 * 内容却全是空的。这类失败最难查。
 */

export interface OrderEdge {
  readonly source: string
  readonly target: string
}

/**
 * 拓扑排序：上游在前，下游在后。
 *
 * 只排传入的 `ids`，其它节点视为不存在：用户只选了 3 个，不该因为
 * 它们之间的连线关系去牵动没选的节点。
 *
 * 有环时**不报错**，而是把剩下的按原顺序追加到尾部：
 * 画布允许有环（比如互相审阅），拒绝执行整批会让用户无从下手。
 * 调用方可以拿 `cyclic` 决定是否提示。
 */
export function orderByDependency(ids: readonly string[], edges: readonly OrderEdge[]): {
  ordered: string[]
  cyclic: string[]
} {
  const wanted = new Set(ids)
  if (wanted.size === 0) return { ordered: [], cyclic: [] }

  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const id of wanted) {
    indegree.set(id, 0)
    outgoing.set(id, [])
  }
  for (const edge of edges) {
    if (!wanted.has(edge.source) || !wanted.has(edge.target)) continue
    if (edge.source === edge.target) continue
    outgoing.get(edge.source)!.push(edge.target)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }

  // 队列保持稳定顺序：入度同为 0 时按用户选中顺序，避免每次跑出来的顺序都不同
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0)
  const ordered: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    ordered.push(current)
    for (const next of outgoing.get(current) ?? []) {
      const left = (indegree.get(next) ?? 1) - 1
      indegree.set(next, left)
      if (left === 0) queue.push(next)
    }
  }

  const placed = new Set(ordered)
  const cyclic = ids.filter((id) => !placed.has(id))
  return { ordered: [...ordered, ...cyclic], cyclic }
}
