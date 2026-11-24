import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFrames, easeOutCubic, frameSize, lerpPoint, restoreTargets, stackTargets } from '../lib/group-motion.ts'

/**
 * 分组的开合动画与位置还原（用户 2026-11-24 要求）。
 *
 * 三条硬要求，任何一条做不到都会被看得见：
 *   · 收起是"所有节点飞向左上角（折叠卡片所在处）、叠在一起"，不是瞬间消失
 *   · 展开要回到**收起前**的相对位置，而不是聚成一堆
 *   · 动画最后一帧必须精确落在目标点（差 1px 都会在下次收起时累积偏移）
 */

test('堆叠点：全部收向组的左上角，且每次调用结果一致', () => {
  const a = stackTargets({ x: 100, y: 200 }, 3)
  const b = stackTargets({ x: 100, y: 200 }, 3)
  assert.deepEqual(a, b)
  assert.equal(a.length, 3)
  // 第一个成员就落在锚点上（折叠卡片的位置），后面的往左上错开
  assert.deepEqual(a[0], { x: 100, y: 200 })
  assert.ok(a[1]!.x < 100 && a[1]!.y < 200, '后续成员向左上错开，形成叠放层次')
})

test('展开框尺寸：按成员相对锚点的最远右/下边缘算，且不小于最小值', () => {
  const size = frameSize([{ x: 40, y: 60 }, { x: 340, y: 300 }])
  // 最远右边缘 340 + 320 节点宽 + 26 留白
  assert.equal(size.width, 340 + 320 + 26)
  assert.equal(size.height, 300 + 220 + 26)

  const tiny = frameSize([])
  assert.ok(tiny.width > 0 && tiny.height > 0, '空组也要给一个最小框')
})

test('缓动：起点 0、终点 1，中间单调递增', () => {
  assert.equal(easeOutCubic(0), 0)
  assert.equal(easeOutCubic(1), 1)
  let previous = 0
  for (let t = 0.1; t <= 1; t += 0.1) {
    const value = easeOutCubic(t)
    assert.ok(value >= previous, '缓动不能回退，否则动画会抖')
    previous = value
  }
})

test('插值：t=1 时精确落在终点（误差不留到下一次动画）', () => {
  const point = lerpPoint({ x: 0, y: 0 }, { x: 300, y: 260 }, 1)
  assert.equal(point.x, 300)
  assert.equal(point.y, 260)
})

test('逐帧表的最后一帧 = 目标位置', () => {
  const from = [{ x: 0, y: 0 }, { x: 400, y: 100 }]
  const to = [{ x: 20, y: 20 }, { x: 20, y: 20 }]
  const frames = buildFrames(from, to, 14)
  assert.equal(frames.length, 14)
  assert.deepEqual(frames.at(-1), to)
})

test('逐帧表：每个节点的第一帧都比原位置更靠近目标（确实在动）', () => {
  const frames = buildFrames([{ x: 0, y: 0 }], [{ x: 100, y: 100 }], 10)
  assert.ok(frames[0]![0]!.x > 0)
  assert.ok(frames[0]![0]!.y > 0)
})

test('展开：有快照就回到收起前的位置（关键需求）', () => {
  const saved = { a: { x: 120, y: 340 }, b: { x: 640, y: 90 } }
  const restored = restoreTargets(saved, ['a', 'b'], { x: 0, y: 0 })
  assert.deepEqual(restored, [
    { id: 'a', point: { x: 120, y: 340 } },
    { id: 'b', point: { x: 640, y: 90 } },
  ])
})

test('展开：没有快照（刷新过页面）时退回网格，且只排这一组的成员', () => {
  // 只有"连当前位置都拿不到"时才走到网格 —— 这是最后兜底，不是常规路径
  const restored = restoreTargets(undefined, ['a', 'b', 'c', 'd'], { x: 100, y: 100 })
  // 每行 3 个：第 4 个换行
  assert.equal(restored[0]!.point.y, restored[2]!.point.y)
  assert.ok(restored[3]!.point.y > restored[0]!.point.y, '第 4 个节点必须换行')
  assert.ok(restored[0]!.point.x > 100, '起点要避开组标题条')
})

test('展开：刷新后没有内存快照，用成员当前坐标还原（用户报"重进后相对位置没了"）', () => {
  const current = { a: { x: 12, y: 34 }, b: { x: 900, y: 120 } }
  const restored = restoreTargets(undefined, ['a', 'b'], { x: 0, y: 0 }, current)
  assert.deepEqual(restored, [
    { id: 'a', point: { x: 12, y: 34 } },
    { id: 'b', point: { x: 900, y: 120 } },
  ])
})

test('展开：内存快照优先于当前坐标（同一会话里收起后又拖动过组）', () => {
  const saved = { a: { x: 1, y: 2 } }
  const current = { a: { x: 300, y: 400 } }
  const restored = restoreTargets(saved, ['a'], { x: 0, y: 0 }, current)
  assert.deepEqual(restored[0], { id: 'a', point: { x: 1, y: 2 } })
})

test('展开：部分有快照时，缺的用网格补，不会整体错乱', () => {
  const restored = restoreTargets({ a: { x: 5, y: 6 } }, ['a', 'b'], { x: 0, y: 0 })
  assert.deepEqual(restored[0], { id: 'a', point: { x: 5, y: 6 } })
  assert.ok(restored[1]!.point.x > 0)
})
