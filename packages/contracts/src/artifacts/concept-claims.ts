import { z } from 'zod'

/**
 * `extract` 的产物：概念论断。
 *
 * 每条 claim 的 `spanIds` 可以为空——但空的那条**必须是 UNVERIFIED**，
 * 且后续 `card` 不得把它写进 `ConceptCard`（硬约束 1）。
 * 这里用 superRefine 把这条约束钉在 schema 上，而不是靠调用方自觉。
 */
export const conceptClaimSchema = z
  .object({
    name: z.string().min(1),
    definition: z.string().min(1),
    spanIds: z.array(z.string().min(1)),
    status: z.enum(['VERIFIED', 'UNVERIFIED']),
    /** 模型给的依据说明，仅用于审计，不展示给学生 */
    rationale: z.string().optional(),
  })
  .superRefine((claim, ctx) => {
    if (claim.status === 'VERIFIED' && claim.spanIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'VERIFIED 的 claim 必须至少有一个 spanId',
        path: ['spanIds'],
      })
    }
  })

export type ConceptClaim = z.infer<typeof conceptClaimSchema>

export const conceptClaimsSchema = z.object({
  sourceId: z.string().min(1),
  claims: z.array(conceptClaimSchema),
})

export type ConceptClaims = z.infer<typeof conceptClaimsSchema>
