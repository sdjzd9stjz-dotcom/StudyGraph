/**
 * 画布多选逻辑（纯函数，不碰 React）。
 *
 * 为什么单独抽出来：Shift 增选/减选是最容易被"看起来能用"骗过去的地方 ——
 * React Flow 在 click 之前就会改写选中态，逻辑写在事件回调里只能靠手点验证，
 * 点错一次也说不清是库的问题还是我们的问题。抽成纯函数后可以逐条断言。
 */

/**
 * Shift+左键之后的选中集合。
 *
 * 输入是**按下鼠标那一刻**的选中集合（`before`），不是点击回调里的 `node.selected`：
 * 库已经在 click 里把点中的节点设为唯一选中，用那个状态取反永远得到"取消"。
 *
 * @param before 按下前的已选节点 id
 * @param nodeId 这一下点中的节点
 * @returns 翻转 `nodeId` 之后的完整选中集合（其它节点原样保留）
 */
export function toggleSelection(before: readonly string[], nodeId: string): string[] {
  const next = new Set(before)
  if (next.has(nodeId)) next.delete(nodeId)
  else next.add(nodeId)
  return [...next]
}

/**
 * 右键菜单打开时应视为"已选中"的节点。
 *
 * 规则：右键点中的节点本来就在多选里 → 保留整组（用户想对整组操作）；
 * 否则只有它自己（库已经把选中态改成只选它了）。
 */
export function selectionForContextMenu(before: readonly string[], nodeId: string | null): string[] {
  if (nodeId === null) return [...before]
  return before.includes(nodeId) ? [...before] : [nodeId]
}
