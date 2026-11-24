import assert from 'node:assert/strict'
import test from 'node:test'

import { selectionForContextMenu, toggleSelection } from '../lib/selection.ts'

/**
 * 画布多选的两条规则（用户 2026-11-24 报障）。
 *
 * 报障原话：「框选之后无法右键打包」「Shift+左键无法增选或少选节点」。
 *
 * 两个都不是"功能没写"，而是**读错了时机**：
 *   · 右键：库在按下的瞬间重写选中态，菜单里再读 nodes.filter(selected) 只剩 1 个
 *   · Shift：库在 click 里先把点中的节点设为唯一选中，再拿它取反永远是"取消"
 * 所以这里断言的是"用按下时的快照"这件事本身。
 */

test('Shift 增选：点一个没选中的节点 → 加进来，其它保持', () => {
  assert.deepEqual(toggleSelection(['a', 'b'], 'c'), ['a', 'b', 'c'])
})

test('Shift 减选：点一个已选中的节点 → 踢出去，其它保持', () => {
  assert.deepEqual(toggleSelection(['a', 'b', 'c'], 'b'), ['a', 'c'])
})

test('Shift 增选不依赖顺序，也不产生重复', () => {
  const once = toggleSelection([], 'a')
  assert.deepEqual(once, ['a'])
  const twice = toggleSelection(once, 'a')
  assert.deepEqual(twice, [], '再点一次必须回到未选中')
})

test('Shift 连点两个不同节点：两个都在', () => {
  let selected: string[] = []
  selected = toggleSelection(selected, 'a')
  selected = toggleSelection(selected, 'b')
  assert.deepEqual(selected.sort(), ['a', 'b'])
})

test('框选 4 个之后右键空白处：4 个都算作选中（打包项才会出现）', () => {
  assert.deepEqual(selectionForContextMenu(['a', 'b', 'c', 'd'], null), ['a', 'b', 'c', 'd'])
})

test('在多选里右键其中一个节点：保留整组，不是只剩它自己', () => {
  assert.deepEqual(selectionForContextMenu(['a', 'b', 'c'], 'b'), ['a', 'b', 'c'])
})

test('右键一个没选中的节点：只针对它（返回单个，打包项不出现）', () => {
  const result = selectionForContextMenu(['a', 'b'], 'z')
  assert.deepEqual(result, ['z'])
  assert.equal(result.length >= 2, false, '单节点右键不该出现打包项')
})

test('空白处右键且没有选中：空数组，不误触发打包', () => {
  assert.deepEqual(selectionForContextMenu([], null), [])
})
