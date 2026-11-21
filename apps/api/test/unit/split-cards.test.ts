import assert from 'node:assert/strict'
import test from 'node:test'

import { splitCardsForConcepts } from '../../src/domain/split-cards.ts'

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
  claims: Array<{ name: string; status: string; spanIds: string[] }>
  existing?: Array<{ id: string; params: Record<string, unknown> }>
}) {
  const created: Array<{ id: string; title: string | null; params: Record<string, unknown>; posX: number; posY: number }> = []
  const edges: Array<{ fromNodeId: string; toNodeId: string }> = []
  let counter = 0

  const prisma = {
    node: {
      findFirst: async ({ where }: any) =>
        where.id === 'extract-1' && where.canvasId === CANVAS && where.type === 'EXTRACT'
          ? { id: 'extract-1', posX: 400, posY: 100 }
          : null,
      findMany: async ({ where }: any) =>
        where.type === 'CARD'
          ? (options.existing ?? []).map((node) => ({ id: node.id, params: node.params }))
          : [],
      create: async ({ data }: any) => {
        counter += 1
        const row = {
          id: `card-${counter}`,
          title: data.title,
          params: data.params,
          posX: data.posX,
          posY: data.posY,
        }
        created.push(row)
        return { id: row.id, title: row.title }
      },
    },
    artifact: {
      findFirst: async () => ({
        kind: 'CONCEPT_CLAIMS',
        structured: { conceptClaims: { claims: options.claims } },
      }),
    },
    edge: {
      create: async ({ data }: any) => {
        edges.push({ fromNodeId: data.fromNodeId, toNodeId: data.toNodeId })
        return { id: `e-${edges.length}` }
      },
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
  assert.equal(outcome.skipped.some((item) => item.reason === '已经拆过了'), true)
})

test('不是本画布的抽取节点 → 明确报错', async () => {
  const { prisma } = makePrisma({ claims: [] })
  await assert.rejects(
    () => splitCardsForConcepts(prisma, { canvasId: 'canvas-2', extractNodeId: 'extract-1' }),
    /不是当前画布上的概念抽取节点/,
  )
})
