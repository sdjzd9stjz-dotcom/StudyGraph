import { z } from 'zod'

/**
 * `extract` 的产物：概念论断。
 *
 * 三档状态（SG-SUP-010 §1.3）：
 * - `VERIFIED`：引文逐字可查 **且** 定义与引文逐字相同
 * - `PENDING_REVIEW`：引文逐字可查，但定义是人的转述 → 等人工复核
 * - `UNVERIFIED`：引文查不到 / 无引文 / 没有谓词 → 不产卡
 *
 * 后两者都必须有至少一个 spanId：待审的**唯一**合法性来源就是"引文查得到"，
 * 允许无引用的待审，会让它比 VERIFIED 更危险（看起来像审核过）。
 */
export const conceptClaimSchema = z
  .object({
    name: z.string().min(1),
    definition: z.string().min(1),
    quote: z.string().optional(),
    spanIds: z.array(z.string().min(1)),
    status: z.enum(['VERIFIED', 'PENDING_REVIEW', 'UNVERIFIED']),
    /** 模型给的依据说明，仅用于审计，不展示给学生 */
    rationale: z.string().optional(),
    /** 分类器给出的失败原因（UNVERIFIED 时非空），便于事后统计 */
    reasons: z.array(z.string()).optional(),
    // ── 判定输入快照（SG-SUP-012 §2.2）：产物必须能脱离数据库重放分类 ──
    /** 判定当时那段 span 原文；span 以后可能被改/删，这里必须留底 */
    spanText: z.string().optional(),
    /** 字符 bigram Jaccard 相似度 */
    similarity: z.number().optional(),
    /** definition.length / quote.length */
    lengthRatio: z.number().optional(),
    promptVersion: z.string().optional(),
    classifierVersion: z.string().optional(),
  })
  .superRefine((claim, ctx) => {
    if (claim.status !== 'UNVERIFIED' && claim.spanIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: `${claim.status} 的 claim 必须至少有一个 spanId`,
        path: ['spanIds'],
      })
    }
  })

export type ConceptClaim = z.infer<typeof conceptClaimSchema>

export const conceptClaimsSchema = z.object({
  sourceId: z.string().min(1),
  claims: z.array(conceptClaimSchema),
  /** 这一批是谁判的（SG-SUP-012 §2.4），便于区分新旧规则 */
  promptVersion: z.string().optional(),
  classifierVersion: z.string().optional(),
})

export type ConceptClaims = z.infer<typeof conceptClaimsSchema>
