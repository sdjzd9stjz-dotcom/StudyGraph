import { classifyClaim, matchesStoredSpan } from '../../spans/claim-support.ts'
import { readPageTexts } from '../../storage/page-text.ts'
import type { ConceptClaims } from '../../../../../packages/contracts/src/index.ts'
import type { NodeExecutor } from '../contract.ts'
import { ZERO_USAGE } from '../contract.ts'

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
  promptVersion: 'extractive-card-v2',
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

      const concept = await ctx.prisma.$transaction(async tx => {
        const where = { canvasId_name: { canvasId: ctx.canvasId, name: claim.name } }
        const current = await tx.concept.findUnique({ where })
        if (current && current.status !== 'UNVERIFIED') {
          if (current.definition !== claim.definition) return null
          const sameEvidence = await tx.conceptCitation.findUnique({
            where: { conceptId_spanId: { conceptId: current.id, spanId: span.id } },
          })
          return sameEvidence?.quote === claim.quote ? current : null
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
        return tx.concept.update({ where: { id: entry.id }, data: { status: classification.verdict } })
      })
      if (concept) created.push({ conceptId: concept.id, name: claim.name, spanId: span.id, status: concept.status })
      else skipped.push({ name: claim.name, reason: '同名概念已有不同证据' })
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
