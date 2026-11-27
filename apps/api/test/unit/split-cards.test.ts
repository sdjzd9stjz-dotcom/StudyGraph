import assert from 'node:assert/strict'
import test from 'node:test'

import { executeCanvasTool } from '../../src/routes/assistant-agent.ts'
import { inspectSplit, splitCardsForConcepts } from '../../src/domain/split-cards.ts'

/**
 * 按概念拆分知识卡（用户 2026-11-21 要求：一概念一节点）。
 *
 * 这段逻辑出错的表现是"知识卡没拆出来"或"拆出一堆空卡"，
 * 两者在界面上都只表现为"没反应"，所以只能在这里把规则钉死：
 *   · 没出处（无 span / UNVERIFIED）的概念不建卡
 *   · 已经拆过的不重复建
 *   · 每张卡都必须有一条 EXTRACT → CARD 的线，否则它成了孤立节点
 */

const CANVAS = 'canvas-1'

function makePrisma(options: {
  claims: Array<{ name: string; status: string; spanIds: string[]; reasons?: string[] }>
  existing?: Array<{ id: string; params: Record<string, unknown> }>
}) {
  const created: Array<{ id: string; title: string | null; params: Record<string, unknown>; posX: number; posY: number }> = []
  const edges: Array<{ fromNodeId: string; toNodeId: string }> = []


  const prisma = {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
    $queryRaw: async () => [],
    node: {
      findFirst: async ({ where }: any) =>
        where.id === 'extract-1' && where.canvasId === CANVAS && where.type === 'EXTRACT'
          ? { id: 'extract-1', posX: 400, posY: 100 }
          : null,
      findMany: async ({ where }: any) =>
        where.type === 'CARD'
          ? (options.existing ?? []).map((node) => ({ id: node.id, params: node.params }))
          : [],
      createMany: async ({ data }: any) => { created.push(...data); return { count: data.length } },
    },
    artifact: {
      findFirst: async () => ({
        kind: 'CONCEPT_CLAIMS',
        structured: { conceptClaims: { claims: options.claims } },
      }),
    },
    edge: {
      createMany: async ({ data }: any) => { edges.push(...data); return { count: data.length } },
    },
  }

  return { prisma: prisma as never, created, edges }
}

test('一概念一节点：有出处的概念各建一张卡，并连到抽取节点', async () => {
  const { prisma, created, edges } = makePrisma({
    claims: [
      { name: '上确界', status: 'VERIFIED', spanIds: ['span-1'] },
      { name: '基本列', status: 'PENDING_REVIEW', spanIds: ['span-2'] },
    ],
  })

  const outcome = await splitCardsForConcepts(prisma, { canvasId: CANVAS, extractNodeId: 'extract-1' })

  assert.equal(outcome.created.length, 2)
  assert.deepEqual(created.map((node) => node.title), ['上确界', '基本列'])
  assert.deepEqual(created.map((node) => node.params.conceptName), ['上确界', '基本列'])
  assert.equal(edges.length, 2, '每张卡都要连到抽取节点，否则是孤立节点')
  assert.ok(edges.every((edge) => edge.fromNodeId === 'extract-1'))
  // 卡片排在抽取节点右侧，不叠在一起
  assert.ok(created[1]!.posY > created[0]!.posY)
})

test('没有出处的概念不建卡（UNVERIFIED / 无 span）', async () => {
  const { prisma, created } = makePrisma({
    claims: [
      { name: '有出处', status: 'VERIFIED', spanIds: ['span-1'] },
      { name: '待复核但可查', status: 'PENDING_REVIEW', spanIds: ['span-2'] },
      { name: '不可溯源', status: 'UNVERIFIED', spanIds: ['span-3'] },
      { name: '没片段', status: 'VERIFIED', spanIds: [] },
    ],
  })

  const outcome = await splitCardsForConcepts(prisma, { canvasId: CANVAS, extractNodeId: 'extract-1' })

  assert.deepEqual(created.map((node) => node.title), ['有出处', '待复核但可查'])
  assert.equal(outcome.skipped.length, 2)
})

test('已经拆过的概念不重复建节点', async () => {
  const { prisma, created } = makePrisma({
    claims: [
      { name: '上确界', status: 'VERIFIED', spanIds: ['span-1'] },
      { name: '基本列', status: 'VERIFIED', spanIds: ['span-2'] },
    ],
    existing: [{ id: 'old', params: { conceptName: '上确界' } }],
  })

  const outcome = await splitCardsForConcepts(prisma, { canvasId: CANVAS, extractNodeId: 'extract-1' })

  assert.deepEqual(created.map((node) => node.title), ['基本列'])
  assert.equal(outcome.skipped.some((item) => item.reason === '画布已有同名卡节点'), true)
})

test('不是本画布的抽取节点 → 明确报错', async () => {
  const { prisma } = makePrisma({ claims: [] })
  await assert.rejects(
    () => splitCardsForConcepts(prisma, { canvasId: 'canvas-2', extractNodeId: 'extract-1' }),
    /不是当前画布上的概念抽取节点/,
  )
})


test('1020 条的拆分保留首因、其余原因和序号，可从对话得到完整统计', async () => {
  const reasons = [['BELOW_SIMILARITY', 672], ['NO_PREDICATE', 329], ['RESIDUAL_TOO_SHORT', 5], ['A1_QUOTE_NOT_IN_SPAN', 5], ['NAME_NOT_IN_DEFINITION', 1]] as const
  const accepted = (name: string) => ({ name, status: 'PENDING_REVIEW', spanIds: ['s'] })
  const claims = [...Array.from({ length: 8 }, (_, i) => accepted('可建' + i)),
    ...reasons.flatMap(([reason, count]) => Array.from({ length: count }, (_, i) => ({ name: reason + i, status: 'UNVERIFIED', spanIds: [], reasons: [reason, 'LENGTH_RATIO_OUT_OF_RANGE'] })))]
  const { prisma, created, edges } = makePrisma({ claims })
  const input = { canvasId: CANVAS, extractNodeId: 'extract-1' }
  const preview = await inspectSplit(prisma, input)
  assert.equal(created.length, 0)
  assert.equal(preview.report.total, 1020)
  assert.equal(preview.report.blocked, 1012)
  assert.deepEqual(preview.report.primaryReasons.map(r => r.count), [672, 329, 5, 5, 1])
  assert.equal(preview.skipped[0]?.index, 9)
  assert.equal(preview.skipped[0]?.details.length, 2)
  const answer = await executeCanvasTool({ prisma, canvasId: CANVAS, userId: 'owner' }, 'split_cards', JSON.stringify(input))
  assert.deepEqual(JSON.parse(JSON.stringify(answer.result).slice(0, 4000)).primaryReasons, preview.report.primaryReasons)
  assert.equal(created.length, 8)
  assert.deepEqual(edges.map(e => e.toNodeId), created.map(n => n.id))
})

test('同名、缺名称和历史缺少校验原因分别计数', async () => {
  const ok = (name: string) => ({ name, status: 'VERIFIED', spanIds: ['s'] })
  const { prisma } = makePrisma({ existing: [{ id: 'old', params: { conceptName: '甲' } }],
    claims: [ok('甲'), ok('乙'), ok('乙'), ok(''), { ...ok('丙'), status: 'UNVERIFIED' }] })
  const { report, skipped } = await inspectSplit(prisma, { canvasId: CANVAS, extractNodeId: 'extract-1' })
  assert.deepEqual([report.total, report.newNodes, report.existing, report.repeated, report.blocked], [5, 1, 1, 1, 2])
  assert.match(skipped.at(-1)!.reason, /未记录细项/)
})
