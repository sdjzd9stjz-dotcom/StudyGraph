import { createHash } from 'node:crypto'

import type { SpanRef } from '../../../../packages/contracts/src/index.ts'

/**
 * span 解析与校验（溯源是物理约束的第一道服务层闸门）。
 *
 * 校验判定是：
 *   verify(span, pageText) = ok  iff  span.charStart >= 0
 *                                 ∧ span.charEnd > span.charStart
 *                                 ∧ pageText.slice(span.charStart, span.charEnd) === span.text
 *
 * ## 缓存规则（SG-SUP-005 A、SG-SUP-006 §1）
 *
 * 缓存命中只允许跳过**读页文本**，不允许跳过**与 span 自身相关的判定**。
 * 因此缓存键必须覆盖判定函数的所有输入：
 *
 *   sourceId · page · charStart · charEnd · sha256(span.text) · 页文本版本
 *
 * 两轮漏检的教训：
 * 1. 键里没有 `span.text` → 同一个 id/区间换个期望文本也能命中旧结论（把校验变成恒真函数）。
 * 2. `loadSourceVersion()` 返回 `undefined` 时曾被当作"版本未变" → 原文明明改了也命中。
 *    现在 `undefined` 等价于"无法判断缓存是否有效"，此时**完全绕过缓存**，直接读文本比对。
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
  // 负偏移先在纯函数层拒掉：Zod 只挡 HTTP 层，内部调用（executor）不经过 Zod
  if (span.charStart < 0 || span.charEnd < 0) {
    return {
      ok: false,
      reason: 'BAD_RANGE',
      detail: `偏移不能为负：charStart=${span.charStart} charEnd=${span.charEnd}`,
    }
  }

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
  /** 可选：源的当前版本（Source.checksum）。返回 undefined 表示"取不到版本"。 */
  readonly loadSourceVersion?: (sourceId: string) => Promise<string | undefined>
  /** 仅便于测试注入 */
  readonly cache?: Map<string, SpanVerification>
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** 判定函数的全部输入都在键里，缺一项都可能让缓存变成恒真函数。 */
function cacheKey(span: SpanRef, pageVersion: string): string {
  return [
    span.sourceId,
    span.page,
    span.charStart,
    span.charEnd,
    sha256(span.text).slice(0, 32),
    pageVersion,
  ].join('|')
}

export function createSpanResolver(deps: SpanResolverDeps): SpanResolver {
  const cache = deps.cache ?? new Map<string, SpanVerification>()

  const compute = async (span: SpanRef): Promise<SpanVerification> => {
    const text = await deps.loadPageText(span.sourceId, span.page)
    return verifySpan(span, text === undefined ? new Map() : new Map([[span.page, text]]))
  }

  return {
    resolve: deps.loadSpan,

    pageText: deps.loadPageText,

    async verify(span) {
      // 有廉价版本查询时：版本可用才允许用缓存
      if (deps.loadSourceVersion) {
        const version = await deps.loadSourceVersion(span.sourceId)

        // 取不到版本 = 无法判断缓存是否有效 → 绕过缓存，直接比对
        if (version === undefined || version === null || version === '') {
          return compute(span)
        }

        const key = cacheKey(span, version)
        const cached = cache.get(key)
        if (cached) return cached

        const result = await compute(span)
        cache.set(key, result)
        return result
      }

      // 没有版本查询：先读文本，用文本哈希当版本（读是省不掉的，算可以省）
      const text = await deps.loadPageText(span.sourceId, span.page)
      const version = sha256(text ?? '\u0000missing-page')
      const key = cacheKey(span, version)

      const cached = cache.get(key)
      if (cached) return cached

      const result = verifySpan(span, text === undefined ? new Map() : new Map([[span.page, text]]))
      cache.set(key, result)
      return result
    },
  }
}
