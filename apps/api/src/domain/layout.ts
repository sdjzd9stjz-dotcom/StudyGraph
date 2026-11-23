/**
 * 一键整理：把画布节点排成"左→右"的分层布局。
 *
 * 为什么不是简单的网格：知识网络的价值在**方向** —— 上游在左、下游在右，
 * 一眼能看出"这份课件最后流到了哪张卡"。纯网格会把连线拉成蜘蛛网。
 *
 * 分层规则：没有上游的节点在第 0 层，其余节点在「所有上游层数 + 1」的最大值上。
 * 环（画布允许多种边，理论上可能成环）不能让它死循环：
 * 轮数超过节点数就把剩下的放到最后一层，布局永远会结束。
 */

export interface LayoutNode {
  readonly id: string
  readonly x: number
  readonly y: number
}

export interface LayoutEdge {
  readonly from: string
  readonly to: string
}

export interface LayoutOptions {
  /** 层间距（横向） */
  readonly columnGap?: number
  /** 同层间距（纵向） */
  readonly rowGap?: number
  readonly originX?: number
  readonly originY?: number
}

export function computeLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions = {},
): Map<string, { x: number; y: number }> {
  /**
   * 间距取值（用户 2026-11-23：「整理得开阔一些，让人看着舒服而不用更规整」）。
   *
   * 之前 340×200 只比节点本身（232 宽）宽一点点，连线和输出卡片挤在一起；
   * 开阔的关键不是"排得整齐"，而是**留白**：列间距 460 让箭头有呼吸空间，
   * 行间距 260 让节点下沿的输出卡片互不遮挡。
   */
  const columnGap = options.columnGap ?? 460
  const rowGap = options.rowGap ?? 260
  const originX = options.originX ?? 80
  const originY = options.originY ?? 80

  const ids = nodes.map((node) => node.id)
  const known = new Set(ids)
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) continue
    incoming.get(edge.to)!.push(edge.from)
  }

  /**
   * 定层：反复"把上游都已定层的节点放到 max(上游)+1"。
   *
   * 卡住 = 剩下的都在环上（谁都等不到上游）。这时**强行解开一条**：
   * 挑"未定层上游最少"的那个先放，把它那些还在环里的上游忽略掉。
   * 这样既保证一定结束，又保证环下游的节点（如 b→c 里的 c）仍然排在环的右边。
   */
  const level = new Map<string, number>()
  const unresolvedParents = (id: string) =>
    incoming.get(id)!.filter((parent) => !level.has(parent) && parent !== id)

  for (let guard = 0; guard <= ids.length && level.size < ids.length; guard += 1) {
    const ready = ids.filter((id) => !level.has(id) && unresolvedParents(id).length === 0)

    if (ready.length > 0) {
      for (const id of ready) {
        const parents = incoming.get(id)!.filter((parent) => level.has(parent))
        level.set(id, parents.length === 0 ? 0 : Math.max(...parents.map((parent) => level.get(parent)!)) + 1)
      }
      continue
    }

    // 只剩环里的节点：强行解一个
    const victim = ids
      .filter((id) => !level.has(id))
      .sort(
        (a, b) =>
          unresolvedParents(a).length - unresolvedParents(b).length || a.localeCompare(b),
      )[0]
    if (!victim) break
    const parents = incoming.get(victim)!.filter((parent) => level.has(parent))
    level.set(victim, parents.length === 0 ? 0 : Math.max(...parents.map((parent) => level.get(parent)!)) + 1)
  }

  // 同层内保持用户原来的纵向顺序，整理只改"排到第几列"，不重排审美
  const buckets = new Map<number, LayoutNode[]>()
  for (const node of nodes) {
    const bucket = buckets.get(level.get(node.id)!) ?? []
    bucket.push(node)
    buckets.set(level.get(node.id)!, bucket)
  }

  const positions = new Map<string, { x: number; y: number }>()
  for (const [depth, bucket] of buckets) {
    bucket.sort((a, b) => (a.y === b.y ? a.id.localeCompare(b.id) : a.y - b.y))
    bucket.forEach((node, index) => {
      positions.set(node.id, {
        x: originX + depth * columnGap,
        y: originY + index * rowGap,
      })
    })
  }
  return positions
}
