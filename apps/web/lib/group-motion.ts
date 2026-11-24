/**
 * 分组的开合动画（纯函数）。
 *
 * 用户 2026-11-24 要求：「多个节点全部向**左上角**收起，最后以多节点叠放的形态呈现」，
 * 并且**展开时要回到收起前的相对位置**。
 *
 * 锚点约定：折叠卡片所在的绝对位置，就是展开后虚线框的左上角。
 * 所以两种形态锚在同一点 —— 开合时框不会"跳"到别处。
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

/**
 * 堆叠点：所有成员收拢到组的**左上角**（就是折叠卡片所在的位置），
 * 逐个向左上错开几像素，形成"一叠卡片"的错位层次。
 *
 * 为什么是左上角：折叠卡片本身就在那里，成员朝它汇集，
 * 收起后视觉上就是"节点被吸进那张卡片里"，而不是飞到框的另一头。
 */
export function stackTargets(
  origin: Point,
  count: number,
  offsets: { x: number; y: number } = { x: 0, y: 0 },
): Point[] {
  return Array.from({ length: count }, (_, index) => ({
    // 每张往上左各错开 3px，叠起来能看出层次；不越界到卡片外面去
    x: origin.x + offsets.x - index * 3,
    y: origin.y + offsets.y - index * 3,
  }))
}

/**
 * 展开态虚线框的尺寸。
 *
 * 入参是成员**相对锚点**的偏移（锚点 = 折叠卡片位置 = 框的左上角），
 * 所以宽度直接取"最远成员的右边缘 + 留白"，不再减锚点坐标。
 */
export function frameSize(
  members: readonly Point[],
  options?: { nodeWidth?: number; nodeHeight?: number; pad?: number; minWidth?: number; minHeight?: number; topInset?: number },
): { width: number; height: number } {
  const nodeWidth = options?.nodeWidth ?? 320
  const nodeHeight = options?.nodeHeight ?? 220
  const pad = options?.pad ?? 26
  const minWidth = options?.minWidth ?? 300
  const minHeight = options?.minHeight ?? 140
  // 左上角的标题条压在框内，成员不能盖住它
  const topInset = options?.topInset ?? 34

  if (members.length === 0) return { width: minWidth, height: minHeight }

  const right = Math.max(...members.map((point) => point.x + nodeWidth))
  const bottom = Math.max(...members.map((point) => point.y + nodeHeight))
  return {
    width: Math.max(right + pad, minWidth),
    height: Math.max(bottom + pad, minHeight + topInset),
  }
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
