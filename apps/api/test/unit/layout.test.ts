import assert from 'node:assert/strict'
import test from 'node:test'

import { computeLayout } from '../../src/domain/layout.ts'

/**
 * 一键整理。
 *
 * 出错的表现很难看：整张图叠成一列、或者连线全反着穿过节点。
 * 所以这里钉死三条：方向（上游在左）、不丢节点、成环也不会卡死。
 */

const node = (id: string, y = 0) => ({ id, x: 0, y })

test('按依赖方向分层：上游在第 0 列，下游逐列右移', () => {
  const positions = computeLayout(
    [node('source'), node('chunk'), node('card'), node('deepen')],
    [
      { from: 'source', to: 'chunk' },
      { from: 'chunk', to: 'card' },
      { from: 'card', to: 'deepen' },
    ],
    { columnGap: 100, rowGap: 50, originX: 0, originY: 0 },
  )

  assert.equal(positions.get('source')!.x, 0)
  assert.equal(positions.get('chunk')!.x, 100)
  assert.equal(positions.get('card')!.x, 200)
  assert.equal(positions.get('deepen')!.x, 300)
})

test('同层节点按原来的纵向顺序排列，不会互换', () => {
  const positions = computeLayout(
    [node('b', 300), node('a', 100)],
    [],
    { rowGap: 200, originY: 0 },
  )
  assert.ok(positions.get('a')!.y < positions.get('b')!.y, '原来在上面的整理后还在上面')
})

test('取出所有节点，一个都不丢（没有上游的节点也在第 0 列）', () => {
  const positions = computeLayout([node('a'), node('b'), node('c')], [{ from: 'a', to: 'b' }])
  assert.equal(positions.size, 3)
  assert.equal(positions.get('c')!.x, positions.get('a')!.x)
})

test('画布成环也不会卡死，环里的节点被放到最后一列', () => {
  const positions = computeLayout(
    [node('a'), node('b'), node('c')],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' }, // 环
      { from: 'b', to: 'c' },
    ],
  )
  assert.equal(positions.size, 3)
  assert.ok(positions.get('c')!.x > positions.get('a')!.x, 'c 必须排在环的右边')
})

test('指向画布外的边被忽略，不影响布局', () => {
  const positions = computeLayout([node('a')], [{ from: 'ghost', to: 'a' }])
  assert.equal(positions.get('a')!.x, 80)
})
