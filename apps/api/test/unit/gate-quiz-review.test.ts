import assert from 'node:assert/strict'
import test from 'node:test'

import { gateExecutor } from '../../src/nodes/executors/gate.ts'
import { reviewExecutor } from '../../src/nodes/executors/review.ts'
import type { NodeExecutorRunCtx } from '../../src/nodes/contract.ts'

/**
 * GATE / REVIEW 的契约测试。
 *
 * 这两个执行器都不调模型，所以可以用桩把整条 run 跑完 —— 不需要数据库。
 * 测的重点不是"能跑"，而是**那些会静默出错的判断**：
 *   · gate 没放行也没写理由 → 必须报错，不能默认放行
 *   · gate 放行但上游是空的 → 必须报错，不能算通过
 *   · review 一张已确认卡都没有 → 必须报错，不能返回空计划
 */

const NOW = new Date('2026-11-21T00:00:00.000Z')

function ctx<P>(params: P, inputs: Record<string, unknown>, prismaExtra: Record<string, unknown> = {}): NodeExecutorRunCtx<P> {
  return {
    params,
    inputs,
    llm: {} as never,
    spans: {} as never,
    user: { id: 'u1', email: 'u@x', name: 'u', scopes: [] } as never,
    prisma: prismaExtra as never,
    canvasId: 'c1',
    nodeId: 'n1',
    objectStore: {} as never,
    skills: [],
  }
}

// ── GATE ─────────────────────────────────────────────────────────────────────

test('GATE：未放行且没有理由 → 抛错（不许默认通过）', async () => {
  await assert.rejects(
    () => gateExecutor.run(ctx({ approved: false }, { cards: { concepts: [] } })),
    /未放行且没有填写理由/,
  )
})

test('GATE：未放行但有理由 → 记为拒绝，不是通过', async () => {
  const result = await gateExecutor.run(ctx({ approved: false, note: '概念卡有 3 张缺引用' }, {}))
  assert.equal((result.outputs as { approved: boolean }).approved, false)
  assert.equal((result.outputs as { note: string }).note, '概念卡有 3 张缺引用')
})

test('GATE：放行但上游完全没有产物 → 抛错（没东西可检查的闸门等于没闸门）', async () => {
  await assert.rejects(
    () => gateExecutor.run(ctx({ approved: true }, {})),
    /没有上游产物/,
  )
})

test('GATE：放行且有上游 → 通过，并把上游形状固化进产物', async () => {
  const result = await gateExecutor.run(
    ctx({ approved: true, checklist: ['概念名是否已入定义'] }, {
      cards: { concepts: [{ id: 'a' }, { id: 'b' }] },
      spans: [{ id: 's1' }],
    }),
  )
  const outputs = result.outputs as {
    approved: boolean
    upstream: Record<string, { kind: string; size: number | null }>
    upstreamArtifacts: number
    checklist: string[]
  }
  assert.equal(outputs.approved, true)
  assert.equal(outputs.upstreamArtifacts, 2)
  // 数组记长度、对象记键数：以后能回答"放行时上游长什么样"
  assert.deepEqual(outputs.upstream.cards, { kind: 'object', size: 1 })
  assert.deepEqual(outputs.upstream.spans, { kind: 'array', size: 1 })
  assert.deepEqual(outputs.checklist, ['概念名是否已入定义'])
})

test('GATE：不调模型，用量必须为 0（否则成本账本会凭空多出 token）', async () => {
  const result = await gateExecutor.run(ctx({ approved: true }, { x: [] }))
  assert.deepEqual(result.usage, { tokensIn: 0, tokensOut: 0, cachedTokens: 0 })
  assert.equal(result.usageRecords, undefined)
})

// ── REVIEW ───────────────────────────────────────────────────────────────────

test('REVIEW：没有已确认概念 → 抛错并说清要先跑 card（不许返回空计划）', async () => {
  await assert.rejects(
    () => reviewExecutor.run(ctx({}, {}, { concept: { findMany: async () => [] } })),
    /没有通过复核的概念/,
  )
})

test('REVIEW：新卡与逾期卡分开统计，过期的排在前面', async () => {
  const prisma = {
    concept: {
      findMany: async () => [
        { id: 'c-new', name: '新卡', mastery: 0, dueAt: null, lastReviewedAt: null, fsrsState: null },
        {
          id: 'c-overdue',
          name: '逾期卡',
          mastery: 0.4,
          dueAt: new Date('2026-11-11T00:00:00.000Z'),
          lastReviewedAt: new Date('2026-11-01T00:00:00.000Z'),
          fsrsState: { stability: 5, difficulty: 5, state: 'REVIEW' },
        },
        {
          id: 'c-future',
          name: '还没到期',
          mastery: 0.9,
          dueAt: new Date('2026-12-01T00:00:00.000Z'),
          lastReviewedAt: new Date('2026-11-20T00:00:00.000Z'),
          fsrsState: { stability: 20, difficulty: 5, state: 'REVIEW' },
        },
      ],
    },
  }

  const result = await reviewExecutor.run(ctx({ asOf: NOW.toISOString() }, {}, prisma))
  const outputs = result.outputs as {
    plan: Array<{ conceptId: string; reason: string; overdueDays: number }>
    summary: { planned: number; newCount: number; overdueCount: number; notDue: number }
  }

  // 未到期的卡不该进计划，但要被计数——静默丢弃会让"今天怎么只有两张"无法解释
  assert.equal(outputs.summary.notDue, 1)
  assert.equal(outputs.summary.newCount, 1)
  assert.equal(outputs.summary.overdueCount, 1)
  assert.equal(outputs.summary.planned, 2)

  // 逾期卡排在新卡之前
  assert.equal(outputs.plan[0]!.conceptId, 'c-overdue')
  assert.equal(outputs.plan[1]!.conceptId, 'c-new')
  assert.equal(outputs.plan[0]!.reason, 'OVERDUE')
  assert.equal(outputs.plan[1]!.reason, 'NEW')

  // 逾期 10 天（11-11 → 11-21）
  assert.equal(outputs.plan[0]!.overdueDays, 10)
})

test('REVIEW：不排新卡时它们不计入计划，但进入 skippedNew', async () => {
  const prisma = {
    concept: {
      findMany: async () => [
        { id: 'c-new', name: '新卡', mastery: 0, dueAt: null, lastReviewedAt: null, fsrsState: null },
      ],
    },
  }
  const result = await reviewExecutor.run(ctx({ includeNew: false, asOf: NOW.toISOString() }, {}, prisma))
  const outputs = result.outputs as { plan: unknown[]; summary: { skippedNew: number; planned: number } }
  assert.equal(outputs.plan.length, 0)
  assert.equal(outputs.summary.skippedNew, 1)
  assert.equal(outputs.summary.planned, 0)
})

test('REVIEW：超过 limit 时截断量必须可见（truncated）', async () => {
  const many = Array.from({ length: 25 }, (_, index) => ({
    id: `c${index}`,
    name: `卡${index}`,
    mastery: 0.1,
    dueAt: new Date('2026-11-01T00:00:00.000Z'),
    lastReviewedAt: new Date('2026-10-01T00:00:00.000Z'),
    fsrsState: { stability: 3, difficulty: 5, state: 'REVIEW' },
  }))
  const result = await reviewExecutor.run(
    ctx({ limit: 10, asOf: NOW.toISOString() }, {}, { concept: { findMany: async () => many } }),
  )
  const outputs = result.outputs as { plan: unknown[]; summary: { truncated: number } }
  assert.equal(outputs.plan.length, 10)
  assert.equal(outputs.summary.truncated, 15)
})

test('REVIEW：不调模型，用量必须为 0', async () => {
  const prisma = {
    concept: {
      findMany: async () => [
        { id: 'c1', name: '卡', mastery: 0, dueAt: null, lastReviewedAt: null, fsrsState: null },
      ],
    },
  }
  const result = await reviewExecutor.run(ctx({}, {}, prisma))
  assert.deepEqual(result.usage, { tokensIn: 0, tokensOut: 0, cachedTokens: 0 })
})

test('REVIEW：非法 asOf 明确报错，不静默用当前时间', async () => {
  await assert.rejects(
    () => reviewExecutor.run(ctx({ asOf: 'not-a-date' }, {}, { concept: { findMany: async () => [] } })),
    /不是合法时间/,
  )
})
