import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { prisma } from '../../../../packages/db/src/index.ts'
import { buildApp } from '../../src/app.ts'
import { loadEnv } from '../../src/env.ts'
import { issueToken } from '../../src/lib/pat.ts'

/**
 * GATE 放行/拒绝接口。
 *
 * 这个接口是闸门唯一能真正放行的地方（执行器本身只会记录，不会替人做决定）。
 * 所以要测的是：**谁能放行、放行留下什么、以及拒绝为什么必须有理由**。
 *
 * 特别测一条：放行后不自动触发下游 —— 自动执行会让"我还没准备好"做不到。
 */

const env = loadEnv({ ...process.env, NODE_ENV: 'test' })

async function setup() {
  const app = await buildApp({ env, prisma })
  const base = await app.listen({ host: '127.0.0.1', port: 0 })

  const owner = await prisma.user.create({
    data: { email: `${randomUUID()}@gate.invalid`, displayName: 'gate-owner' },
    select: { id: true },
  })
  const outsider = await prisma.user.create({
    data: { email: `${randomUUID()}@gate.invalid`, displayName: 'gate-outsider' },
    select: { id: true },
  })

  async function tokenFor(userId: string) {
    const { token, tokenPrefix, tokenHash } = issueToken()
    await prisma.personalAccessToken.create({
      data: { userId, tokenPrefix, tokenHash, name: 'test', scopes: ['CANVAS_WRITE'] },
    })
    return token
  }

  const ownerToken = await tokenFor(owner.id)
  const outsiderToken = await tokenFor(outsider.id)

  const canvas = await prisma.canvas.create({
    data: { ownerId: owner.id, title: '闸门验收' },
    select: { id: true },
  })
  const gate = await prisma.node.create({
    data: { canvasId: canvas.id, type: 'GATE', params: { approved: false }, posX: 0, posY: 0 },
    select: { id: true },
  })
  const review = await prisma.node.create({
    data: { canvasId: canvas.id, type: 'REVIEW', params: {}, posX: 0, posY: 0 },
    select: { id: true },
  })
  // 下游：用来证明放行不会自动执行它
  await prisma.edge.create({
    data: { canvasId: canvas.id, fromNodeId: gate.id, toNodeId: review.id, kind: 'DERIVED_FROM', fromPort: 'out', toPort: 'in' },
  })

  const decide = (nodeId: string, body: unknown, token = ownerToken) =>
    app.inject({
      method: 'POST',
      url: `/v1/nodes/${nodeId}/gate-decision`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: body as never,
    })

  return { app, base, canvas, gate, review, ownerToken, outsiderToken, decide }
}

test('GATE：放行后 params.approved=true，并留下决策人与时间', async () => {
  const { app, gate, decide } = await setup()
  try {
    const response = await decide(gate.id, { approved: true, note: '概念卡引用齐全' })
    assert.equal(response.statusCode, 200)

    const body = response.json() as { approved: boolean; decidedAt: string; downstreamTriggered: boolean }
    assert.equal(body.approved, true)
    // 硬约束 2：放行不等于开跑
    assert.equal(body.downstreamTriggered, false)

    const saved = await prisma.node.findUniqueOrThrow({ where: { id: gate.id }, select: { params: true } })
    const params = saved.params as { approved: boolean; note: string; decidedBy: string; decidedAt: string }
    assert.equal(params.approved, true)
    assert.equal(params.note, '概念卡引用齐全')
    assert.equal(typeof params.decidedBy, 'string')
    assert.equal(typeof params.decidedAt, 'string')
  } finally {
    await app.close()
  }
})

test('GATE：拒绝必须带理由，空理由被拒（400）', async () => {
  const { app, gate, decide } = await setup()
  try {
    const noNote = await decide(gate.id, { approved: false })
    assert.equal(noNote.statusCode, 400)

    const emptyNote = await decide(gate.id, { approved: false, note: '   ' })
    assert.equal(emptyNote.statusCode, 400, '只有空白的理由等于没理由')

    // 拒绝成功：approved 保持 false
    const rejected = await decide(gate.id, { approved: false, note: '第 3 张卡定义里没有出现概念名' })
    assert.equal(rejected.statusCode, 200)
    const saved = await prisma.node.findUniqueOrThrow({ where: { id: gate.id }, select: { params: true } })
    assert.equal((saved.params as { approved: boolean }).approved, false)
  } finally {
    await app.close()
  }
})

test('GATE：非 GATE 节点调用放行接口 → 400 NODE_NOT_GATE', async () => {
  const { app, review, decide } = await setup()
  try {
    const response = await decide(review.id, { approved: true })
    assert.equal(response.statusCode, 400)
    const body = response.json() as { error: { code: string } }
    assert.equal(body.error.code, 'NODE_NOT_GATE')
  } finally {
    await app.close()
  }
})

test('GATE：非画布成员不能放行（返回 404，不泄露画布是否存在）', async () => {
  const { app, gate, decide, outsiderToken } = await setup()
  try {
    const response = await decide(gate.id, { approved: true }, outsiderToken)
    // 不是 403 而是 404：`requireCanvasWrite` 对"根本看不到这张画布"的人
    // 与"画布不存在"给同一个答案，避免拿 id 探测别人有哪些画布。
    // 只读成员（看得到但没写权限）才是 403。
    assert.equal(response.statusCode, 404)
    // 越权尝试不能改到数据
    const saved = await prisma.node.findUniqueOrThrow({ where: { id: gate.id }, select: { params: true } })
    assert.equal((saved.params as { approved: boolean }).approved, false)
  } finally {
    await app.close()
  }
})

test('GATE：放行不给下游建 Run（不自动执行）', async () => {
  const { app, gate, review, decide } = await setup()
  try {
    const before = await prisma.run.count({ where: { nodeId: review.id } })
    await decide(gate.id, { approved: true })
    const after = await prisma.run.count({ where: { nodeId: review.id } })
    assert.equal(before, after, '放行后下游 Run 数量必须不变')
    const gateRuns = await prisma.run.count({ where: { nodeId: gate.id } })
    assert.equal(gateRuns, 0, '放行动作本身也不该产生 Run')
  } finally {
    await app.close()
  }
})
