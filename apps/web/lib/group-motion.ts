/**
 * 分组的开合动画（纯函数）。
 *
 * 用户 2026-11-24 要求：「多个节点全部向右上角收起，最后以多节点叠放的形态呈现」，
 * 并且**展开时要回到收起前的相对位置**。
 *
 * 为什么位置要自己记：收起时把成员节点移到了堆叠点，如果不保存原坐标，
 * 展开只能靠网格重排 —— 用户精心摆的链就毁了（真实反馈）。
 *
 * 动画本身由 requestAnimationFrame 逐帧插值实现：把每个节点的位置
 * 从 `from` 线性推到 `to`，缓动函数用 easeOutCubic（起步快、收尾稳，
 * 比线性更像物理动作）。
 */

export interface Point {
  x: number
  y: number
}

/** 堆叠点：所有成员收拢到组的右上角，逐个偏移几像素，形成"一叠卡片" */
export function stackTargets(
  origin: Point,
  count: number,
  offsets: { x: number; y: number } = { x: 26, y: 18 },
): Point[] {
  return Array.from({ length: count }, () => ({ x: origin.x + offsets.x, y: origin.y + offsets.y }))
}

export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t))
  return 1 - Math.pow(1 - clamped, 3)
}

/** 在两个位置之间插值 */
export function lerpPoint(from: Point, to: Point, t: number): Point {
  const k = easeOutCubic(t)
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }
}

/**
 * 一次动画里每一帧的位置表。
 *
 * 返回 `frames.length × ids.length` 的位置，调用方逐帧应用。
 * 之所以在这里算好而不是在 rAF 回调里现算：算好的表可以断言，
 * 避免"动画结束位置差了 1px"这类只能靠眼睛发现的问题。
 */
export function buildFrames(
  from: readonly Point[],
  to: readonly Point[],
  frameCount: number,
): Point[][] {
  const frames: Point[][] = []
  for (let frame = 1; frame <= frameCount; frame += 1) {
    const t = frame / frameCount
    frames.push(from.map((start, index) => lerpPoint(start, to[index] ?? start, t)))
  }
  return frames
}

/**
 * 展开时成员应该回到哪。
 *
 * 有快照（收起时记下的原坐标）就用快照；没有（比如刷新过页面）
 * 退回网格排布，并且只动这一组的成员。
 */
export function restoreTargets(
  saved: Record<string, Point> | undefined,
  memberIds: readonly string[],
  fallbackOrigin: Point,
): Array<{ id: string; point: Point }> {
  return memberIds.map((id, index) => {
    const known = saved?.[id]
    if (known) return { id, point: { ...known } }
    return {
      id,
      point: {
        x: fallbackOrigin.x + 20 + (index % 3) * 300,
        y: fallbackOrigin.y + 46 + Math.floor(index / 3) * 260,
      },
    }
  })
}
