import { z } from 'zod'

/** 一个语义切片。必须能追溯回源页（pageStart/pageEnd）与具体 span。 */
export const chunkSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().nonnegative(),
  text: z.string().min(1),
  /** 至少一个 span：切片没有出处就是凭空生成的 */
  spanIds: z.array(z.string().min(1)).min(1),
  pageStart: z.number().int().min(1),
  pageEnd: z.number().int().min(1),
  /** 估算 token，用于成本前置（不是厂商返回值，不参与计量） */
  estimatedTokens: z.number().int().nonnegative().optional(),
})

export type Chunk = z.infer<typeof chunkSchema>

export const chunkSetSchema = z.object({
  sourceId: z.string().min(1),
  chunks: z.array(chunkSchema).min(1),
})

export type ChunkSet = z.infer<typeof chunkSetSchema>
