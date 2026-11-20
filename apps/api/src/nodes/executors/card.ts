import { classifyClaim, matchesStoredSpan } from '../../spans/claim-support.ts'
import { readPageTexts } from '../../storage/page-text.ts'
import type { ConceptClaims } from '../../../../../packages/contracts/src/index.ts'
import type { NodeExecutor } from '../contract.ts'
import type { PrismaClient } from '../../../../../packages/db/src/index.ts'
import { ZERO_USAGE } from '../contract.ts'

/** Review decisions can change independently of the upstream artifact hash. */
export async function cardCacheIsCurrent(prisma: PrismaClient, nodeId: string, canvasId: string): Promise<boolean> {
  const artifact = await prisma.artifact.findFirst({
    where: { nodeId, kind: 'CONCEPT_CARD' }, orderBy: { createdAt: 'desc' }, select: { structured: true },
  })
  const saved = artifact?.structured as { cards?: {
    cards?: { conceptId: string; status: string }[]
    skipped?: { reason: string }[]
  } } | null
  if (!Array.isArray(saved?.cards?.cards) || !Array.isArray(saved.cards.skipped)) return false
  // Re-evaluate skips that depended on the current entity or on resolving its evidence.
  if (saved.cards.skipped.some(item => !item.reason.startsWith('UNVERIFIED('))) return false
  const cards = saved.cards.cards
  const rows = await prisma.concept.findMany({
    where: { canvasId, id: { in: cards.map(card => card.conceptId) } }, select: { id: true, status: true },
  })
  const states = new Map(rows.map(row => [row.id, row.status]))
  return cards.every(card => states.get(card.conceptId) === card.status)
}

/**
 * `card` 执行器（SG-SUP-009 §4.2）。
 *
 * 规则：
 * - **只从上游 ConceptClaims 建卡**，不从零生成
 * - 每个 claim 必须有可 resolve 的 span；没有 span 的 claim **不产卡**
 * - 落库顺序：先建 UNVERIFIED → 写 ConceptCitation → 置 VERIFIED
 *   （guards 的 BEFORE UPDATE 触发器会拦住"没有引用就 VERIFIED"）
 *
 * 这个执行器**不调模型**：卡片内容就是 claim 的 name/definition，
 * 引用就是 claim 的 span。任何"再让模型润色一下"的做法都会引入无出处的文字。
 */
export const cardExecutor: NodeExecutor = {
  type: 'CARD',
  artifactKind: 'CONCEPT_CARD',
  promptVersion: 'extractive-card-v3',
  inputs: { type: 'object', properties: { conceptClaims: { type: 'object' } }, required: ['conceptClaims'] },
  outputs: { type: 'object', properties: { cards: { type: 'object' } }, required: ['cards'] },

  async run(ctx) {
    const conceptClaims = ctx.inputs.conceptClaims as ConceptClaims | undefined
    if (!conceptClaims?.claims) throw new Error('card 节点缺少上游 conceptClaims')

    const created: Array<{ conceptId: string; name: string; spanId: string; status: string }> = []
    const skipped: Array<{ name: string; reason: string }> = []

    const pages = await readPageTexts(ctx.objectStore, ctx.canvasId, conceptClaims.sourceId)
    if (!pages) throw new Error('无法读取引用原文')
    for (const claim of conceptClaims.claims) {
      // 只跳过 UNVERIFIED；PENDING_REVIEW 也建卡（引文可查，只是定义待人复核）
      if (claim.status === 'UNVERIFIED' || claim.spanIds.length === 0) {
        skipped.push({ name: claim.name, reason: `UNVERIFIED(${(claim.reasons ?? []).join(',') || '无原因'})` })
        continue
      }

      const span = await ctx.prisma.span.findFirst({
        where: { id: claim.spanIds[0], sourceId: conceptClaims.sourceId, source: { node: { canvasId: ctx.canvasId } } },
      })
      // 用同一个分类器复核：card 不信任上游的状态，自己再判一次
      const classification = span && matchesStoredSpan(span, pages)
        ? classifyClaim({ name: claim.name, definition: claim.definition, quote: claim.quote, spanText: span.text })
        : { verdict: 'UNVERIFIED' as const }
      if (!span || classification.verdict === 'UNVERIFIED') {
        skipped.push({ name: claim.name, reason: '引文、原文或定义不匹配' })
        continue
      }

      const outcome = await ctx.prisma.$transaction(async (tx) => {
        const where = { canvasId_name: { canvasId: ctx.canvasId, name: claim.name } }
        const current = await tx.concept.findUnique({ where })

        if (current) {
          const existingCitation = await tx.conceptCitation.findUnique({
            where: { conceptId_spanId: { conceptId: current.id, spanId: span.id } },
          })
          // 「证据变了」= span 不同 或 quote 不同；定义文本变了不算（同一句引文还是同一条证据）
          const evidenceChanged = !existingCitation || existingCitation.quote !== claim.quote

          // 被人工拒绝过的：不得被重跑重新打开（SG-SUP-011 §4.1）
          if (current.status === 'UNVERIFIED' && current.reviewedBy && !evidenceChanged) {
            if (current.reviewDecision === 'REJECT') return { kind: 'REJECTED_BY_REVIEWER' as const }
            if (!current.reviewDecision) return { kind: 'LEGACY_REVIEW_UNKNOWN' as const }
            if (current.definition === claim.definition) {
              const restored = await tx.concept.update({ where: { id: current.id }, data: { status: 'VERIFIED' } })
              return { kind: 'KEPT' as const, concept: restored }
            }
          }
          if (current.status !== 'UNVERIFIED') {
            if (current.definition !== claim.definition) return { kind: 'CONFLICT' as const }
            return evidenceChanged ? { kind: 'CONFLICT' as const } : { kind: 'KEPT' as const, concept: current }
          }
          // 证据变了 → 清空复核记录，按新证据重新分类
          if (current.status === 'UNVERIFIED' && current.reviewedBy) {
            await tx.concept.update({ where: { id: current.id }, data: { reviewedAt: null, reviewedBy: null, reviewDecision: null } })
          }
        }

        const entry = await tx.concept.upsert({
          where, create: { ...where.canvasId_name, definition: claim.definition, status: 'UNVERIFIED' },
          update: { definition: claim.definition },
        })
        // A reverified definition replaces citations attached to the former definition.
        await tx.conceptCitation.deleteMany({ where: { conceptId: entry.id } })
        await tx.conceptCitation.create({ data: {
          conceptId: entry.id, spanId: span.id, isPrimary: true, quote: claim.quote!,
        } })
        const updated = await tx.concept.update({ where: { id: entry.id }, data: { status: classification.verdict } })
        return { kind: 'CREATED' as const, concept: updated }
      })

      if (outcome.kind === 'REJECTED_BY_REVIEWER' || outcome.kind === 'LEGACY_REVIEW_UNKNOWN') {
        skipped.push({ name: claim.name, reason: outcome.kind })
      } else if (outcome.kind === 'CONFLICT') {
        skipped.push({ name: claim.name, reason: '同名概念已有不同证据' })
      } else {
        created.push({ conceptId: outcome.concept.id, name: claim.name, spanId: span.id, status: outcome.concept.status })
      }
    }

    return {
      outputs: {
        cards: {
          total: created.length,
          verified: created.filter((card) => card.status === 'VERIFIED').length,
          pendingReview: created.filter((card) => card.status === 'PENDING_REVIEW').length,
          unverified: created.filter((card) => card.status === 'UNVERIFIED').length,
          skipped,
          cards: created,
        },
      },
      usage: ZERO_USAGE,
    }
  },
}
