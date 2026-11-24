import assert from 'node:assert/strict'
import test from 'node:test'

import { changedPositions, saveLabel } from '../lib/save-state.ts'

/**
 * 退出画布前的"保存"（用户 2026-11-24 要求：退出时保存全部画布数据，
 * 并且让用户看得见正在保存）。
 *
 * 要点：
 *   · 只提交真正变了的坐标 —— 否则退出时会一次发出几十个 PATCH，
 *     还没发完页面就关了，反而更容易丢
 *   · 取整比较：服务端存整数坐标，用浮点比会永远判"变了"
 *   · 保存状态要有文案，不能让用户不知道发生了什么事
 */

test('没有改动时返回空：退出不该无谓地重写整张画布', () => {
  const saved = { a: { x: 10, y: 20 }, b: { x: 30, y: 40 } }
  const changed = changedPositions(
    [
      { id: 'a', x: 10, y: 20 },
      { id: 'b', x: 30, y: 40 },
    ],
    saved,
  )
  assert.deepEqual(changed, [])
})

test('坐标变了就进差异列表', () => {
  const saved = { a: { x: 10, y: 20 } }
  const changed = changedPositions([{ id: 'a', x: 12, y: 20 }], saved)
  assert.deepEqual(changed, [{ id: 'a', x: 12, y: 20 }])
})

test('新节点（没有已保存值）一定算改动', () => {
  const changed = changedPositions([{ id: 'new', x: 0, y: 0 }], {})
  assert.equal(changed.length, 1)
})

test('取整后相同就不算改动：避免浮点抖动把每个节点都重写一遍', () => {
  // 10.4 / 20.4 与 10.1 / 20.2 取整后都是 10 / 20：画布缩放带来的亚像素差不算改动
  const saved = { a: { x: 10.4, y: 20.4 } }
  const changed = changedPositions([{ id: 'a', x: 10.1, y: 20.2 }], saved)
  assert.deepEqual(changed, [])
})

test('跨过整数边界才算改动', () => {
  const saved = { a: { x: 10.4, y: 20.4 } }
  const changed = changedPositions([{ id: 'a', x: 10.6, y: 20.4 }], saved)
  assert.equal(changed.length, 1)
})

test('保存提示有明确文案，idle 时不占屏幕', () => {
  assert.equal(saveLabel('idle', 0), null)
  assert.match(saveLabel('saving', 3) ?? '', /正在保存/)
  assert.match(saveLabel('saved', 0) ?? '', /已保存/)
  assert.match(saveLabel('error', 0) ?? '', /失败/)
})
