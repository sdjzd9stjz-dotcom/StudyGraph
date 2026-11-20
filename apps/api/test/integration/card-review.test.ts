import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { prisma } from '../../../../packages/db/src/index.ts'
import { buildApp } from '../../src/app.ts'
import { loadEnv } from '../../src/env.ts'
import { issueToken } from '../../src/lib/pat.ts'
import { createGateway } from '../../src/llm/gateway.ts'
import { executeNode } from '../../src/nodes/execute.ts'
import { checkConceptCitations } from '../../src/spans/citation-integrity.ts'
import { createObjectStore } from '../../src/storage/object-store.ts'
import { pageTextKey, writePageTexts } from '../../src/storage/page-text.ts'

test('人工拒绝、巡检降级和缓存通过真实复核与执行入口区分', async () => {
  const env = loadEnv({ ...process.env, NODE_ENV: 'test' })
  const objectStore = createObjectStore({ endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY })
  const user = await prisma.user.create({ data: { email: randomUUID() + '@audit.invalid', displayName: 'teacher' } })
  const viewer = await prisma.user.create({ data: { email: randomUUID() + '@audit.invalid', displayName: 'viewer' } })
  const app = await buildApp({ env, prisma })
  let key = ''
  try {
    const base = await app.listen({ host: '127.0.0.1', port: 0 })
    async function tokenFor(userId: string) {
      const { token, tokenPrefix, tokenHash } = issueToken()
      await prisma.personalAccessToken.create({ data: { userId, tokenPrefix, tokenHash, name: 'test', scopes: ['CANVAS_WRITE'] } })
      return token
    }
    const writer = await tokenFor(user.id), reader = await tokenFor(viewer.id)
    const canvas = await prisma.canvas.create({ data: { ownerId: user.id, title: '复核回归' } })
    const canvasId = canvas.id
    await prisma.canvasMember.create({ data: { canvasId, userId: viewer.id, role: 'VIEWER' } })
    const extract = await prisma.node.create({ data: { canvasId, type: 'EXTRACT', params: {}, posX: 0, posY: 0 } })
    const card = await prisma.node.create({ data: { canvasId, type: 'CARD', params: {}, posX: 0, posY: 0 } })
    await prisma.edge.create({ data: { canvasId, fromNodeId: extract.id, toNodeId: card.id, kind: 'DERIVED_FROM', fromPort: 'out', toPort: 'in' } })
    const source = await prisma.source.create({ data: { nodeId: extract.id, kind: 'PPTX', filename: 'test', mimeType: 'text/plain' } })
    const name = '连续函数', quote = '在区间上每一点都连续的函数称为连续函数。'
    const definition = '连续函数是指在区间上每一点都连续的函数。'
    const pages = [1, 2].map(page => ({ page, region: 'SLIDE' as const, text: quote }))
    key = pageTextKey(canvasId, source.id)
    await writePageTexts(objectStore, canvasId, source.id, pages)
    const spans = await Promise.all(pages.map(p => prisma.span.create({ data: {
      ...p, sourceId: source.id, charStart: 0, charEnd: quote.length,
    } })))
    async function publish(spanId: string) {
      await prisma.artifact.create({ data: { nodeId: extract.id, kind: 'CONCEPT_CLAIMS', hash: spanId,
        structured: { conceptClaims: { sourceId: source.id, claims: [{ name, definition, quote, status: 'PENDING_REVIEW', spanIds: [spanId] }] } } } })
    }
    const llm = createGateway({ resolveApiKey: async () => null })
    const run = () => executeNode({ user, prisma, objectStore, llm }, card.id, { dryRun: false })
    await publish(spans[0]!.id)
    await run()
    const where = { canvasId_name: { canvasId, name } }
    const row = () => prisma.concept.findUniqueOrThrow({ where })
    const id = (await row()).id
    function post(body: string, token = writer) {
      return fetch(base + '/v1/concepts/' + id + '/review', { method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body })
    }
    assert.equal((await run()).status, 'CACHED')
    assert.equal((await post('{"decision":"ACCEPT"}', reader)).status, 403)
    const invalid = await post('{"decision":"BAD"}')
    assert.equal(invalid.status, 400)
    assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, 'VALIDATION_FAILED')
    assert.equal(((await (await post('{')).json()) as { error: { code: string } }).error.code, 'INVALID_JSON')
    assert.equal((await post('{"decision":"REJECT"}')).status, 200)
    const refreshed = await run()
    assert.equal(refreshed.status, 'SUCCEEDED')
    const saved = await prisma.artifact.findFirstOrThrow({ where: { runId: refreshed.runId! } })
    assert.deepEqual(saved.structured, { cards: { total: 0, verified: 0, pendingReview: 0, unverified: 0,
      skipped: [{ name, reason: 'REJECTED_BY_REVIEWER' }], cards: [] } })
    assert.equal((await row()).reviewDecision, 'REJECT')
    await publish(spans[1]!.id)
    await run()
    const reopened = await row()
    assert.deepEqual([reopened.status, reopened.reviewDecision, reopened.reviewedAt, reopened.reviewedBy], ['PENDING_REVIEW', null, null, null])
    const reviews = await Promise.all([post('{"decision":"ACCEPT"}'), post('{"decision":"ACCEPT"}')])
    assert.deepEqual(reviews.map(r => r.status).sort(), [200, 409])
    await writePageTexts(objectStore, canvasId, source.id, [{ ...pages[1]!, text: '原文已变' }])
    assert.deepEqual((await checkConceptCitations({ prisma, objectStore }, canvasId)).downgraded, [id])
    assert.equal((await row()).reviewDecision, 'ACCEPT')
    await writePageTexts(objectStore, canvasId, source.id, pages)
    await run()
    const restored = await row()
    assert.deepEqual([restored.status, restored.reviewDecision, restored.reviewedBy], ['VERIFIED', 'ACCEPT', user.id])
    console.log('viewer=403 invalid=400 malformed=400 rejectRerun=0 changedEvidence=PENDING_REVIEW concurrent=200/409 restored=VERIFIED/ACCEPT')
  } finally {
    await app.close()
    if (key) await objectStore.deleteMany([key])
    await prisma.user.deleteMany({ where: { id: { in: [user.id, viewer.id] } } })
    await prisma.$disconnect()
  }
})

