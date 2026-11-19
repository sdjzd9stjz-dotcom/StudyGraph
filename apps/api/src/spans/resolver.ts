import { createHash } from 'node:crypto'

import type { SpanRef } from '../../../../packages/contracts/src/index.ts'

/**
 * span 解析与校验（溯源是物理约束的第一道服务层闸门）。
 *
 * 校验的是**逐字符相等**：`span.text === pageText.slice(charStart, charEnd)`。
 *
 * ## 缓存必须绑定原文版本（SG-SUP-005 缺陷 A）
 *
 * 曾经按 `(spanId, 范围)` 缓存校验结果，原文从 `abc` 改成 `xyz` 后仍返回 `ok: true`
 * —— 这不是性能问题，是硬约束 1 被击穿：原文变了，引用必须失效。
 *
 * 现在缓存条目里存的是**当时页文本的 sha256**（或 `Source.checksum`），
 * 读到条目后先比对版本，不一致就重算：
 *
 * - 没有 `loadSourceVersion` 时：每次 verify 取页文本 → 算哈希 → 命中则复用，否则重算。
 *   代价是每次都要读一次页文本，但绝不会给出过期结论。
 * - 提供 `loadSourceVersion` 时（生产：查 `Source.checksum`）：先用版本号定位条目，
 *   命中就**不读页文本**，两全。
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
  /** 可选：源的当前版本（Source.checksum）。提供后命中缓存可以不读页文本。 */
  readonly loadSourceVersion?: (sourceId: string) => Promise<string | undefined>
  /** 仅便于测试注入 */
  readonly cache?: Map<string, { version: string; result: SpanVerification }>
}

const textHash = (text: string | undefined): string =>
  createHash('sha256').update(text ?? '\u0000missing-page').digest('hex')

export function createSpanResolver(deps: SpanResolverDeps): SpanResolver {
  const cache = deps.cache ?? new Map<string, { version: string; result: SpanVerification }>()

  return {
    resolve: deps.loadSpan,

    pageText: deps.loadPageText,

    async verify(span) {
      const key = `${span.id}|${span.page}|${span.charStart}|${span.charEnd}`

      // 有廉价版本查询时：版本相同即可直接复用，不必读页文本
      if (deps.loadSourceVersion) {
        const version = (await deps.loadSourceVersion(span.sourceId)) ?? 'unknown'
        const cached = cache.get(key)
        if (cached && cached.version === version) return cached.result

        const text = await deps.loadPageText(span.sourceId, span.page)
        const result = verifySpan(span, text === undefined ? new Map() : new Map([[span.page, text]]))
        cache.set(key, { version, result })
        return result
      }

      // 没有版本查询时：用页文本哈希判断条目是否还新鲜
      const text = await deps.loadPageText(span.sourceId, span.page)
      const version = textHash(text)
      const cached = cache.get(key)
      if (cached && cached.version === version) return cached.result

      const result = verifySpan(span, text === undefined ? new Map() : new Map([[span.page, text]]))
      cache.set(key, { version, result })
      return result
    },
  }
}
