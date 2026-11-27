import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { ChunkSet } from '../../../../packages/contracts/src/index.ts'
import { prisma } from '../../../../packages/db/src/index.ts'
import { createGateway } from '../../src/llm/gateway.ts'
import { executeNode } from '../../src/nodes/execute.ts'
import { registerBuiltinExecutors } from '../../src/nodes/executors/index.ts'
import { createObjectStore } from '../../src/storage/object-store.ts'

test('数学字符跨默认切点时，运行节点可保存产物并从 PostgreSQL 无损读回', async t => {
  registerBuiltinExecutors()
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@chunk.invalid`, displayName: '切片回归' } })
  t.after(async () => { await prisma.user.delete({ where: { id: user.id } }) })
  const canvas = await prisma.canvas.create({ data: { ownerId: user.id, title: '切片回归' } })
  const sourceNode = await prisma.node.create({ data: { canvasId: canvas.id, type: 'SOURCE' } })
  const chunkNode = await prisma.node.create({ data: { canvasId: canvas.id, type: 'CHUNK' } })
  await prisma.edge.create({ data: { canvasId: canvas.id, fromNodeId: sourceNode.id, toNodeId: chunkNode.id, kind: 'DERIVED_FROM' } })
  const source = await prisma.source.create({ data: { nodeId: sourceNode.id, kind: 'PDF', filename: 'math.pdf', mimeType: 'application/pdf' } })
  await prisma.artifact.create({ data: { nodeId: sourceNode.id, kind: 'SOURCE_TEXT', hash: randomUUID(), structured: { sourceDoc: { sourceId: source.id } } } })
  const text = '数'.repeat(799) + '𝑑𝜒𠮷😀\\sqrt{x}'
  const span = await prisma.span.create({ data: { sourceId: source.id, page: 3, region: 'PAGE', charStart: 0, charEnd: text.length, text } })
  const deps = { prisma, user, objectStore: createObjectStore({}), llm: createGateway({ resolveApiKey: async () => null }) }
  const run = () => executeNode(deps, chunkNode.id, { dryRun: false })
  const result = await run()
  assert.equal(result.status, 'SUCCEEDED')
  const saved = await prisma.artifact.findFirstOrThrow({ where: { runId: result.runId! } })
  const { chunkSet } = saved.structured as unknown as { chunkSet: ChunkSet }
  assert.deepEqual(chunkSet.chunks.map(c => c.text), ['数'.repeat(799) + '𝑑', '𝜒𠮷😀\\sqrt{x}'])
  assert.equal(chunkSet.chunks.map(c => c.text).join(''), text)
  for (const c of chunkSet.chunks) {
    assert.equal(c.pageStart, 3)
    assert.equal(c.pageEnd, 3)
    assert.deepEqual(c.spanIds, [span.id])
  }
  assert.equal((await run()).cacheHit, true)
})
