import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_WEIGHTS, currentMastery, intervalForRetention, retrievability, schedule } from '../../src/domain/fsrs.ts'
import type { FsrsState } from '../../src/domain/fsrs.ts'

const NOW = new Date('2026-11-21T00:00:00.000Z')

/** 把某个结果转成下一次的输入状态 */
const asState = (result: ReturnType<typeof schedule>, lastReviewedAt: Date): FsrsState => ({
  stability: result.stability,
  difficulty: result.difficulty,
  state: result.state,
  lastReviewedAt,
})

test('可提取性：t=0 时为 1，t=S 时约为 0.9，随时间单调不增', () => {
  assert.equal(retrievability(0, 10), 1)
  // FSRS 的定义：经过 S 天后可提取性约为 0.9
  assert.ok(Math.abs(retrievability(10, 10) - 0.9) < 0.001, `实际 ${retrievability(10, 10)}`)

  const series = [0, 1, 5, 10, 50, 200].map((t) => retrievability(t, 10))
  for (let i = 1; i < series.length; i += 1) {
    assert.ok(series[i]! <= series[i - 1]!, `t 增大时 R 不该上升：${JSON.stringify(series)}`)
  }
})

test('间隔反推：目标保留率 0.9 时应回到原始稳定性附近', () => {
  assert.ok(Math.abs(intervalForRetention(0.9, 10) - 10) < 0.01)
  // 要求更低的保留率 → 间隔更长
  assert.ok(intervalForRetention(0.8, 10) > intervalForRetention(0.9, 10))
})

test('新卡首次评分：稳定性等于对应的初始权重', () => {
  const good = schedule({ state: null, grade: 'GOOD', now: NOW })
  assert.ok(Math.abs(good.stability - DEFAULT_WEIGHTS[2]!) < 1e-9, `实际 ${good.stability}`)
  assert.ok(good.dueAt.getTime() > NOW.getTime())

  const easy = schedule({ state: null, grade: 'EASY', now: NOW })
  const again = schedule({ state: null, grade: 'AGAIN', now: NOW })
  // 评分越高，初始稳定性越大：EASY > GOOD > HARD > AGAIN
  const hard = schedule({ state: null, grade: 'HARD', now: NOW })
  assert.ok(easy.stability > good.stability)
  assert.ok(good.stability > hard.stability)
  assert.ok(hard.stability > again.stability)
})

test('连续 GOOD：间隔必须单调不降（否则学生会觉得软件在反复打断）', () => {
  let state: FsrsState | null = null
  let lastDate = NOW
  const intervals: number[] = []

  for (let i = 0; i < 6; i += 1) {
    const result = schedule({ state, grade: 'GOOD', now: lastDate })
    intervals.push(result.scheduledDays)
    state = asState(result, lastDate)
    lastDate = result.dueAt
  }

  for (let i = 1; i < intervals.length; i += 1) {
    assert.ok(
      intervals[i]! >= intervals[i - 1]!,
      `第 ${i + 1} 次复习的间隔 ${intervals[i]} 小于上一次 ${intervals[i - 1]}；全部：${intervals.join(', ')}`,
    )
  }
  // 且确实变长了，而不是原地踏步
  assert.ok(intervals[intervals.length - 1]! > intervals[0]! * 2, `间隔没有增长：${intervals.join(', ')}`)
})

test('AGAIN 必须把卡打回复习中，并把稳定性压回去', () => {
  let state: FsrsState | null = null
  let lastDate = NOW
  for (let i = 0; i < 4; i += 1) {
    const r = schedule({ state, grade: 'GOOD', now: lastDate })
    state = asState(r, lastDate)
    lastDate = r.dueAt
  }
  const before = state!.stability
  assert.equal(state!.state, 'REVIEW')

  const failed = schedule({ state, grade: 'AGAIN', now: lastDate })
  assert.equal(failed.state, 'RELEARNING', '已进入复习态的卡答错应变成 RELEARNING')
  assert.ok(failed.stability < before, `答错后稳定性应从 ${before} 下降到更小值，实际 ${failed.stability}`)
  assert.ok(failed.scheduledDays < 30, `答错后间隔应很短，实际 ${failed.scheduledDays} 天`)
})

test('同一天内狂点 GOOD 不会把间隔刷上天（短时公式）', () => {
  const first = schedule({ state: null, grade: 'GOOD', now: NOW })
  const state = asState(first, NOW)
  let result = first
  for (let i = 1; i <= 5; i += 1) {
    result = schedule({ state: asState(result, NOW), grade: 'GOOD', now: NOW })
  }
  // 半小时内点六次，间隔不该涨到月级
  assert.ok(result.scheduledDays < 30, `实际 ${result.scheduledDays} 天`)
})

test('掌握度：刚复习完接近 1，久了自然衰减', () => {
  const result = schedule({ state: null, grade: 'GOOD', now: NOW })
  const fresh = currentMastery(asState(result, NOW), NOW)
  assert.ok(fresh > 0.99, `刚复习完应接近 1，实际 ${fresh}`)

  const later = new Date(NOW.getTime() + result.stability * 86_400_000)
  const decayed = currentMastery(asState(result, NOW), later)
  assert.ok(decayed < fresh, '时间过去后掌握度必须下降')
  assert.ok(Math.abs(decayed - 0.9) < 0.01, `经过一个稳定性周期应约 0.9，实际 ${decayed}`)
})

test('没有复习记录的卡掌握度为 0', () => {
  assert.equal(currentMastery({ stability: 0, difficulty: 5, state: 'NEW', lastReviewedAt: null }, NOW), 0)
})

test('稳定性有上界，不会溢出成 Infinity', () => {
  let state: FsrsState | null = null
  let lastDate = NOW
  for (let i = 0; i < 40; i += 1) {
    const r = schedule({ state, grade: 'EASY', now: lastDate })
    state = asState(r, lastDate)
    lastDate = r.dueAt
  }
  assert.ok(Number.isFinite(state!.stability), `稳定性溢出：${state!.stability}`)
  assert.ok(state!.stability <= 36_500)
})
