import { z } from 'zod'

/** `source` 节点的产物：原文已落 S3，这里只留摘要与索引位置。 */
export const sourceDocSchema = z.object({
  sourceId: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  /** 真实页数，不许填死值 */
  pageCount: z.number().int().positive(),
  /** 原文件 sha256（十六进制 64 位） */
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  /** 原文在 S3 的 key：canvas/<canvasId>/source/<sourceId>/text.json */
  textKey: z.string().min(1),
  spanCount: z.number().int().nonnegative(),
})

export type SourceDoc = z.infer<typeof sourceDocSchema>
