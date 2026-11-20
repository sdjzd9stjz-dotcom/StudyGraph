// 把一个画布的全部 EXTRACT 产物导出成可离线重放的 JSON（SG-SUP-015 §2.3 用）。
//
// 用途：校准表不连库也能重跑 —— 产物里已经带了 quote / spanText / classifierVersion，
// 导出的文件直接喂给 scripts/replay-calibration.mjs 即可。
//
// 用法：node scripts/export-canvas-claims.mjs <canvasId> [输出目录，默认 .tmp-backup/claims]
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

process.chdir(path.resolve(import.meta.dirname, '..'))
process.loadEnvFile('.env')

const { prisma } = await import('../packages/db/src/index.ts')

const canvasId = process.argv[2]
const outDir = process.argv[3] ?? '.tmp-backup/claims'
if (!canvasId) {
  console.error('用法：node scripts/export-canvas-claims.mjs <canvasId> [输出目录]')
  process.exit(2)
}

const nodes = await prisma.node.findMany({
  where: { canvasId, type: 'EXTRACT' },
  orderBy: { createdAt: 'asc' },
  select: { id: true, title: true },
})
if (nodes.length === 0) {
  console.error(`画布 ${canvasId} 上没有 EXTRACT 节点`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
const summary = []
for (const [index, node] of nodes.entries()) {
  const artifact = await prisma.artifact.findFirst({
    where: { nodeId: node.id, kind: 'CONCEPT_CLAIMS' },
    orderBy: { createdAt: 'desc' },
  })
  if (!artifact) {
    summary.push({ nodeId: node.id, exported: false, reason: 'no artifact' })
    continue
  }
  const file = path.join(outDir, `extract-${index + 1}.json`)
  writeFileSync(file, JSON.stringify(artifact.structured, null, 2))
  const claims = artifact.structured?.conceptClaims?.claims ?? []
  summary.push({
    nodeId: node.id,
    file,
    claims: claims.length,
    byStatus: claims.reduce((acc, claim) => ({ ...acc, [claim.status]: (acc[claim.status] ?? 0) + 1 }), {}),
  })
}

console.log(JSON.stringify({ canvasId, outDir, extractNodes: nodes.length, summary }, null, 2))
await prisma.$disconnect()
