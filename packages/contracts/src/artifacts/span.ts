import { z } from 'zod'

/**
 * 溯源的最小单位。
 *
 * ## charStart / charEnd 相对于什么文本（SG-SUP-004 §3.5 要求现在定死）
 *
 * **相对于该页的纯文本**（选项 a）。具体定义：
 *
 * - 页文本 = PDF 该页所有文本项按阅读顺序拼接后的字符串，**不做任何空白压缩、不做字符替换**
 * - `page` 从 1 开始；`charStart` 含、`charEnd` 不含（`[start, end)`）
 * - 恒有 `text === pageText.slice(charStart, charEnd)`
 *
 * 为什么不用"整篇文档的偏移"：整篇偏移依赖页间分隔符的约定，换一个解析器就会整体错位；
 * 页内偏移是自包含的，第三方拿同一页文本就能复现（校验脚本正是这么做的）。
 * 为什么不用"规范化后的字符串"：规范化规则一旦调整，历史 span 全部漂移，而漂移是静默的。
 */
export const spanRefSchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    page: z.number().int().min(1),
    charStart: z.number().int().min(0),
    charEnd: z.number().int().min(0),
    text: z.string(),
  })
  .refine((value) => value.charEnd > value.charStart, {
    message: 'charEnd 必须大于 charStart（零长度 span 无法高亮）',
    path: ['charEnd'],
  })

export type SpanRef = z.infer<typeof spanRefSchema>

/** 一页的纯文本，用于校验 span（M2 存在 S3，校验时按需取）。 */
export const pageTextSchema = z.object({
  page: z.number().int().min(1),
  text: z.string(),
})

export type PageText = z.infer<typeof pageTextSchema>
