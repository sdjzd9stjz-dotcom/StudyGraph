/**
 * 画布"保存"状态的显示与"离开前落库"的入口（用户 2026-11-24 要求）。
 *
 * 为什么要单独做：画布上绝大多数操作是**即时写接口**的（拖节点、连线、打包），
 * 但"拖到一半直接关掉/点返回"仍可能丢最后几像素的位置；用户还希望
 * 在退出时把整张画布的状态一起确认一遍，并且**看得见正在保存**。
 *
 * 这里只放纯逻辑与一个轻量的状态条组件，真正的 PATCH 由 CanvasWorkbench 发起
 * （它才知道哪些坐标变了）。
 */

export type SavePhase = 'idle' | 'saving' | 'saved' | 'error'

/**
 * 保存提示的文案。
 * `idle` 不显示；`saved` 只停留很短时间，避免一直挂在屏幕上。
 */
export function saveLabel(phase: SavePhase, count: number): string | null {
  if (phase === 'idle') return null
  if (phase === 'saving') return count > 0 ? `正在保存 ${count} 项…` : '正在保存…'
  if (phase === 'saved') return '已保存'
  return '保存失败（下次进画布可能回到旧位置）'
}

/**
 * 需要写回服务端的差异。
 *
 * 只比较 `posX/posY`：标题、状态这些每个操作都单独走接口，不需要在这里重复提交。
 * 取整后再比 —— 服务端存的是取整后的坐标，用浮点比较会永远认为"变了"，
 * 于是一次退出就把所有节点重写一遍。
 */
export interface PositionLike {
  id: string
  x: number
  y: number
}

export function changedPositions(
  current: readonly PositionLike[],
  saved: Readonly<Record<string, { x: number; y: number }>>,
): PositionLike[] {
  return current.filter((item) => {
    const before = saved[item.id]
    if (!before) return true
    return Math.round(before.x) !== Math.round(item.x) || Math.round(before.y) !== Math.round(item.y)
  })
}
