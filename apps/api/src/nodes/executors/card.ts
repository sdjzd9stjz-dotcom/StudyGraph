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
  promptVersion: 'no-prompt',
  inputs: { type: 'object', properties: { conceptClaims: { type: 'object' } }, required: ['conceptClaims'] },
  outputs: { type: 'object', properties: { cards: { type: 'object' } }, required: ['cards'] },

  async run(ctx) {
    const conceptClaims = ctx.inputs.conceptClaims as ConceptClaims | undefined
    if (!conceptClaims?.claims) throw new Error('card 节点缺少上游 conceptClaims')

    const created: Array<{ conceptId: string; name: string; spanId: string; status: string }> = []
    const skipped: Array<{ name: string; reason: string }> = []

    for (const claim of conceptClaims.claims) {
      if (claim.status !== 'VERIFIED' || claim.spanIds.length === 0) {
        skipped.push({ name: claim.name, reason: '没有可 resolve 的 span' })
        continue
      }

      // 同名概念去重（同一概念被多个 chunk 抽到时只建一张卡）
      const existing = await ctx.prisma.concept.findFirst({
        where: { canvasId: ctx.canvasId, name: claim.name },
        select: { id: true },
      })
      if (existing) {
        skipped.push({ name: claim.name, reason: '同名概念已存在' })
        continue
      }

      const spanId = claim.spanIds[0]!

      // 顺序不能反：UNVERIFIED → 引用 → VERIFIED
      const concept = await ctx.prisma.concept.create({
        data: {
          canvasId: ctx.canvasId,
          name: claim.name,
          definition: claim.definition,
          status: 'UNVERIFIED',
        },
        select: { id: true },
      })

      await ctx.prisma.conceptCitation.create({
        data: {
          conceptId: concept.id,
          spanId,
          isPrimary: true,
          quote: claim.definition.slice(0, 200),
        },
      })

      try {
        await ctx.prisma.concept.update({ where: { id: concept.id }, data: { status: 'VERIFIED' } })
        created.push({ conceptId: concept.id, name: claim.name, spanId, status: 'VERIFIED' })
      } catch {
        // 触发器拦下（例如 span 失效）：保持 UNVERIFIED，不掩盖
        created.push({ conceptId: concept.id, name: claim.name, spanId, status: 'UNVERIFIED' })
      }
    }

    return {
      outputs: {
        cards: {
          total: created.length,
          verified: created.filter((card) => card.status === 'VERIFIED').length,
          unverified: created.filter((card) => card.status === 'UNVERIFIED').length,
          skipped,
          cards: created,
        },
      },
      usage: ZERO_USAGE,
    }
  },
}
