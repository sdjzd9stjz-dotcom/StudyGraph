import { z } from 'zod'

/**
 * `card` 的产物：一张概念卡。
 *
 * `citations` 至少一条——这是"无源不入卡"在类型层的表达。
 * 入卡论断还要在运行时逐个 resolve 并校验原文，schema 只能保证"有引用"，
 * 保证不了"引用支撑论断"（那要靠 `apps/api/src/spans/resolver.ts`）。
 */
export const citationSchema = z.object({
  spanId: z.string().min(1),
  quote: z.string().min(1),
  page: z.number().int().min(1),
})

export const conceptCardSchema = z.object({
  conceptId: z.string().min(1),
  name: z.string().min(1),
  definition: z.string().min(1),
  citations: z.array(citationSchema).min(1),
})

export type ConceptCard = z.infer<typeof conceptCardSchema>

export const conceptCardSetSchema = z.object({
  cards: z.array(conceptCardSchema),
  /** 被拦下的论断数：无 span 或 span 校验不通过 */
  rejectedClaims: z.number().int().nonnegative(),
})

export type ConceptCardSet = z.infer<typeof conceptCardSetSchema>
