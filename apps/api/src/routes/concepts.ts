import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { findCanvasForUser } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'
import { readPageTexts } from '../storage/page-text.ts'
import type { ObjectStore } from '../storage/object-store.ts'

/**
 * 概念列表与溯源数据（SG-SUP-017 §12 溯源抽屉）。
 *
 * 抽屉要能回答三件事，缺一件就用不了：
 *   ① 这张卡的每个引用是**哪一句**（quote）
 *   ② 这句话在**哪一页、哪个区间**（page / region / charStart / charEnd）
 *   ③ 把整页原文拉出来，把区间**标出来**（full text + 偏移）
 *
 * 注意：这里只返回概念与引用位置，**不做任何状态判定**。
 * 判定仍然只在 claim-support / citation-integrity 里，避免出现"第二套判据"。
 */

const listQuery = z.object({
  status: z.enum(['VERIFIED', 'PENDING_REVIEW', 'UNVERIFIED']).optional(),
})

const spanParams = z.object({ id: z.string().min(1) })

/** 抽屉可以带 quote：高亮的是这一句，而不是整个 span（M2 的 span 是整页一片） */
const contextQuery = z.object({ quote: z.string().optional() })

/** 抽屉里高亮区间的上下文：前后各取这么多字符，避免把整页塞给前端 */
const CONTEXT_WINDOW = 260

export interface ConceptRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
  readonly objectStore: ObjectStore
}

export function registerConceptRoutes(app: FastifyInstance, deps: ConceptRouteDeps): void {
  const { prisma, guard, objectStore } = deps

  app.get('/v1/canvases/:id/concepts', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const { status } = parse(listQuery, request.query)
    await findCanvasForUser(prisma, id, auth.user.id)

    const concepts = await prisma.concept.findMany({
      where: { canvasId: id, ...(status ? { status } : {}) },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        definition: true,
        status: true,
        mastery: true,
        reviewedBy: true,
        citations: {
          select: {
            id: true,
            quote: true,
            isPrimary: true,
            span: { select: { id: true, page: true, region: true, charStart: true, charEnd: true } },
          },
        },
      },
    })

    return {
      canvasId: id,
      concepts: concepts.map((concept) => ({
        ...concept,
        citations: concept.citations.map((citation) => ({
          id: citation.id,
          quote: citation.quote,
          isPrimary: citation.isPrimary,
          spanId: citation.span.id,
          page: citation.span.page,
          region: citation.span.region,
          charStart: citation.span.charStart,
          charEnd: citation.span.charEnd,
        })),
      })),
    }
  })

  /**
   * 单个 span 的原文上下文。抽屉据此渲染「整页 + 高亮」。
   *
   * 取不到页文本时返回 `pageText: null` 并附 reason —— **不返回空字符串冒充"没有内容"**，
   * 否则前端无法区分「这页真的是空的」与「S3 挂了」。
   */
  app.get('/v1/spans/:id/context', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const { id } = parse(spanParams, request.params)
    const query = parse(contextQuery, request.query)

    const span = await prisma.span.findUnique({
      where: { id },
      select: {
        id: true,
        page: true,
        region: true,
        charStart: true,
        charEnd: true,
        text: true,
        source: {
          select: {
            id: true,
            filename: true,
            node: { select: { canvasId: true } },
          },
        },
      },
    })
    if (!span) throw new AppError(404, 'NODE_NOT_FOUND', 'span 不存在', { id })

    const canvasId = span.source.node.canvasId
    await findCanvasForUser(prisma, canvasId, auth.user.id)

    const pages = await readPageTexts(objectStore, canvasId, span.source.id)
    const page = pages?.find((item) => item.page === span.page && item.region === span.region)

    if (!page) {
      return {
        spanId: span.id,
        sourceId: span.source.id,
        filename: span.source.filename,
        page: span.page,
        region: span.region,
        charStart: span.charStart,
        charEnd: span.charEnd,
        quote: span.text,
        pageText: null,
        reason: pages ? 'PAGE_NOT_FOUND' : 'PAGE_TEXT_UNAVAILABLE',
        context: null,
      }
    }

    // 高亮谁？——**引文，不是 span**。
    //
    // M2 的 span 是"一页一片"（charStart=0、charEnd=整页长度），
    // 直接拿 span 区间高亮会把整页标黄，等于没标出是哪一句。
    // 所以要定位的是本次引用的 `quote`（query 参数）在页内的位置；
    // 没给 quote 或找不到时才退回 span 区间。
    //
    // 找不到时**不猜**：返回 highlight=null + reason，前端显示"定位不到"，
    // 而不是标一个看着像对的错区间。
    const quote = (query.quote ?? span.text).trim()
    const inPage = quote.length > 0 ? page.text.indexOf(quote) : -1
    const inSpanOnly = inPage === -1 && page.text.includes(span.text.trim())
    const located = inPage !== -1

    const highlight = located
      ? { start: inPage, end: inPage + quote.length }
      : inSpanOnly
        ? { start: page.text.indexOf(span.text.trim()), end: page.text.indexOf(span.text.trim()) + span.text.trim().length }
        : null

    if (!highlight) {
      return {
        spanId: span.id,
        sourceId: span.source.id,
        filename: span.source.filename,
        page: span.page,
        region: span.region,
        charStart: span.charStart,
        charEnd: span.charEnd,
        quote,
        pageText: page.text,
        reason: 'QUOTE_NOT_IN_PAGE_TEXT',
        context: null,
      }
    }

    const from = Math.max(0, highlight.start - CONTEXT_WINDOW)
    const to = Math.min(page.text.length, highlight.end + CONTEXT_WINDOW)

    return {
      spanId: span.id,
      sourceId: span.source.id,
      filename: span.source.filename,
      page: span.page,
      region: span.region,
      charStart: highlight.start,
      charEnd: highlight.end,
      quote,
      pageText: page.text,
      reason: null,
      highlightSource: located ? 'QUOTE' : 'SPAN',
      // 抽屉只渲染这一段；偏移是相对 context 的，直接和 context 一起给，避免前端自己算错
      context: {
        text: page.text.slice(from, to),
        highlightStart: highlight.start - from,
        highlightEnd: highlight.end - from,
        truncatedBefore: from > 0,
        truncatedAfter: to < page.text.length,
      },
    }
  })
}
