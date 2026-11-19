import type { SpanRef } from '../../../../packages/contracts/src/index.ts'
import { hashToken } from '../lib/pat.ts'

/**
 * span 解析与校验（溯源是物理约束的第一道服务层闸门）。
 *
 * 校验的是**逐字符相等**：`span.text === pageText.slice(charStart, charEnd)`。
 * 只要解析器或切片逻辑有一处不一致，这里就会报 TEXT_MISMATCH，
 * 而不是把一段看起来合理、其实对不上的原文写进卡片。
 */
export type SpanVerification =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: 'BAD_RANGE' | 'PAGE_MISSING' | 'TEXT_MISMATCH' | 'EMPTY_TEXT'
      readonly detail: string
    }

export function verifySpan(
  span: SpanRef,
  pageTexts: ReadonlyMap<number, string>,
): SpanVerification {
  if (span.charEnd <= span.charStart) {
    return {
      ok: false,
      reason: 'BAD_RANGE',
      detail: `charStart=${span.charStart} charEnd=${span.charEnd}（零长度 span 无法高亮）`,
    }
  }

  const pageText = pageTexts.get(span.page)
  if (pageText === undefined) {
    return { ok: false, reason: 'PAGE_MISSING', detail: `第 ${span.page} 页没有文本` }
  }

  if (span.charEnd > pageText.length) {
    return {
      ok: false,
      reason: 'BAD_RANGE',
      detail: `charEnd=${span.charEnd} 超出第 ${span.page} 页长度 ${pageText.length}`,
    }
  }

  const actual = pageText.slice(span.charStart, span.charEnd)
  if (actual !== span.text) {
    return {
      ok: false,
      reason: 'TEXT_MISMATCH',
      detail: `第 ${span.page} 页 [${span.charStart},${span.charEnd}) 期望「${span.text.slice(0, 40)}」实际「${actual.slice(0, 40)}」`,
    }
  }

  if (span.text.trim().length === 0) {
    return { ok: false, reason: 'EMPTY_TEXT', detail: 'span 文本只有空白，不能作为论断依据' }
  }

  return { ok: true }
}

export interface SpanResolver {
  resolve(spanId: string): Promise<SpanRef | null>
  pageText(sourceId: string, page: number): Promise<string | undefined>
  verify(span: SpanRef): Promise<SpanVerification>
}

export interface SpanResolverDeps {
  readonly loadSpan: (spanId: string) => Promise<SpanRef | null>
  readonly loadPageText: (sourceId: string, page: number) => Promise<string | undefined>
  /** 校验结果缓存，避免同一 span 在一张卡里被校验多次 */
  readonly cache?: Map<string, SpanVerification>
}

export function createSpanResolver(deps: SpanResolverDeps): SpanResolver {
  const cache = deps.cache ?? new Map<string, SpanVerification>()

  return {
    resolve: deps.loadSpan,

    pageText: deps.loadPageText,

    async verify(span) {
      const key = `${span.sourceId}:${span.page}:${span.charStart}:${span.charEnd}:${hashToken(span.text).slice(0, 8)}`
      const cached = cache.get(key)
      if (cached) return cached

      const text = await deps.loadPageText(span.sourceId, span.page)
      const verification = verifySpan(span, new Map(text === undefined ? [] : [[span.page, text]]))
      cache.set(key, verification)
      return verification
    },
  }
}
