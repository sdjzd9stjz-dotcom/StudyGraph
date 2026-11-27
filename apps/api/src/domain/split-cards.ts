import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { defaultPortName, validateConnection } from '../../../../packages/contracts/src/index.ts'
import type { SplitDetail, SplitReport } from '../../../../packages/contracts/src/split-report.ts'
import type { ClaimReason } from '../spans/claim-support.ts'
import { nodeInputMissing } from '../lib/errors.ts'

const reasonLabels: Record<ClaimReason, string> = {
  NO_QUOTE: '缺少原文引文', A1_QUOTE_NOT_IN_SPAN: '引文未在对应原文中逐字找到',
  EMPTY_DEFINITION: '缺少定义', NAME_NOT_IN_DEFINITION: '定义未包含概念名称',
  NO_PREDICATE: '未识别出定义中的谓词', RESIDUAL_TOO_SHORT: '除去名称后的说明过短',
  DEFINITION_TOO_SHORT: '定义过短', BELOW_SIMILARITY: '定义与引文字面相似度不足',
  LENGTH_RATIO_OUT_OF_RANGE: '定义与引文长度比例超出范围', DEFINITION_EQUALS_NAME: '定义只有名称',
  UNSUPPORTED_DEFINITION: '定义缺少引文支撑',
}
interface Claim { name?: unknown; status?: unknown; spanIds?: unknown; reasons?: unknown; definition?: unknown; quote?: unknown }
interface Input { canvasId: string; extractNodeId: string }

type SplitReader = Pick<Prisma.TransactionClient, 'node' | 'artifact'>

async function planSplit(db: SplitReader, input: Input) {
  const extract = await db.node.findFirst({ where: { id: input.extractNodeId, canvasId: input.canvasId, type: 'EXTRACT' },
    select: { id: true, posX: true, posY: true } })
  if (!extract) throw nodeInputMissing('这个节点不是当前画布上的概念抽取节点')
  const artifact = await db.artifact.findFirst({ where: { nodeId: extract.id, kind: 'CONCEPT_CLAIMS' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { structured: true } })
  const claims = (artifact?.structured as { conceptClaims?: { claims?: Claim[] } } | null)?.conceptClaims?.claims
  if (!Array.isArray(claims)) throw nodeInputMissing('请先运行概念抽取，再查看拆分结果')
  const cards = await db.node.findMany({ where: { canvasId: input.canvasId, type: 'CARD' }, select: { params: true } })
  const existing = new Set(cards.flatMap(card => {
    const name = (card.params as { conceptName?: unknown } | null)?.conceptName
    return typeof name === 'string' && name.trim() ? [name.trim()] : []
  }))
  const names = new Set<string>()
  const skipped: SplitDetail[] = []
  const counts = new Map<string, number>()
  const report: SplitReport = { total: claims.length, newNodes: 0, existing: 0, repeated: 0, blocked: 0, primaryReasons: [] }
  for (const [index, claim] of claims.entries()) {
    const name = typeof claim?.name === 'string' ? claim.name.trim() : ''
    let category: 'blocked' | 'existing' | 'repeated' = 'blocked'
    let details: string[]
    if (!name) details = ['缺少概念名称']
    else if (claim.status === 'UNVERIFIED') {
      const codes = Array.isArray(claim.reasons) ? claim.reasons.filter((code): code is string => typeof code === 'string' && !!code) : []
      details = codes.map(code => Object.hasOwn(reasonLabels, code) ? reasonLabels[code as ClaimReason] : `其他校验原因（${code}）`)
      if (!details.length) details = ['未通过抽取校验，本次抽取未记录细项']
    } else if (!Array.isArray(claim.spanIds) || !claim.spanIds.some(id => typeof id === 'string' && id.trim())) details = ['缺少可引用的原文片段']
    else if (claim.status !== 'VERIFIED' && claim.status !== 'PENDING_REVIEW') details = ['缺少有效的抽取判定']
    else if (existing.has(name)) { category = 'existing'; details = ['画布已有同名卡节点'] }
    else if (names.has(name)) { category = 'repeated'; details = ['本批已有同名条目建卡'] }
    else { names.add(name); continue }
    const reason = details[0]!
    report[category]++
    if (category === 'blocked') {
      counts.set(reason, (counts.get(reason) ?? 0) + 1)
    }
    skipped.push({ index: index + 1, name: name || '（未命名）', reason, details,
      ...(typeof claim?.definition === 'string' ? { definition: claim.definition } : {}),
      ...(typeof claim?.quote === 'string' ? { quote: claim.quote } : {}) })
  }
  report.newNodes = names.size
  report.primaryReasons = [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count)
  return { extract, names, priorCount: existing.size, report, skipped }
}

export async function inspectSplit(prisma: PrismaClient, input: Input) {
  const { report, skipped } = await planSplit(prisma, input)
  return { report, skipped }
}

export async function splitCardsForConcepts(prisma: PrismaClient, input: Input) {
  return prisma.$transaction(async tx => {
    // 判重范围是整张画布。右键与对话同时拆分时，后提交的一方应看见前一批节点及连线。
    await tx.$queryRaw`SELECT id FROM "Canvas" WHERE id = ${input.canvasId} FOR UPDATE`
    const { report, skipped, names, priorCount, extract } = await planSplit(tx, input)
    const created = [...names].map(conceptName => ({ id: randomUUID(), conceptName,
      title: conceptName.slice(0, 200).replace(/[\uD800-\uDBFF]$/u, '') }))
    if (created.length) {
      const fromPort = defaultPortName('EXTRACT', 'output')!, toPort = defaultPortName('CARD', 'input')!
      if (!validateConnection({ fromType: 'EXTRACT', fromPort, toType: 'CARD', toPort }).ok) throw new Error('抽取节点与知识卡的端口不匹配')
      await tx.node.createMany({ data: created.map(({ id, title, conceptName }, i) => ({ id, canvasId: input.canvasId, type: 'CARD', title,
        params: { conceptName }, status: 'DRAFT', posX: extract.posX + 340 + Math.floor((priorCount + i) / 4) * 320,
        posY: extract.posY + ((priorCount + i) % 4) * 190 })) })
      await tx.edge.createMany({ data: created.map(({ id }) => ({ canvasId: input.canvasId, fromNodeId: extract.id, toNodeId: id,
        kind: 'DERIVED_FROM', fromPort, toPort })) })
    }
    return { created, skipped, report, extractNodeId: extract.id }
  }, { timeout: 30000 })
}
