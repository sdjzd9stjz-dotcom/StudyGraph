'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { CanvasConcept } from '../lib/api'

/**
 * 概念卡列表 + 溯源抽屉（SG-SUP-017 §12）。
 *
 * 交互：点卡片上的引用角标 → 右侧抽屉打开，显示**该页原文**并把引文区间高亮。
 *
 * 三条约束（写进代码而不是只写进文档）：
 * 1. 抽屉里的高亮区间来自服务端算好的 `context.highlightStart/End`，**前端不自己算偏移**
 *    —— 偏移算错时页面看着正常，高亮却错位，这是最难发现的一类错
 * 2. `pageText` 取不到时明确显示原因（`PAGE_TEXT_UNAVAILABLE` / `PAGE_NOT_FOUND`），
 *    绝不显示成「本页没有内容」
 * 3. 没有引用的概念卡不能显示成「已溯源」——角标区写「无引用」，与状态无关
 */

const STATUS_TONE: Record<string, { label: string; color: string; bg: string }> = {
  VERIFIED: { label: '已验证', color: '#15803d', bg: '#dcfce7' },
  PENDING_REVIEW: { label: '待复核', color: '#b45309', bg: '#fef3c7' },
  UNVERIFIED: { label: '未验证', color: '#6b7280', bg: '#f3f4f6' },
}

interface SpanContext {
  spanId: string
  filename: string
  page: number
  region: string
  charStart: number
  charEnd: number
  quote: string
  pageText: string | null
  reason: string | null
  context: {
    text: string
    highlightStart: number
    highlightEnd: number
    truncatedBefore: boolean
    truncatedAfter: boolean
  } | null
}

const REASON_TEXT: Record<string, string> = {
  PAGE_TEXT_UNAVAILABLE: '取不到该来源的原文（对象存储不可用或原文未上传）',
  PAGE_NOT_FOUND: '原文里没有这一页（页码或区域对不上）',
  QUOTE_NOT_IN_PAGE_TEXT: '这一句在原文里定位不到（引文与原文可能已被改动，不标注以免标错位置）',
}

export interface ConceptPanelProps {
  canvasId: string
  /** 运行时注入（桌面版每次启动的端口都不同），不要在客户端读 NEXT_PUBLIC_* */
  apiBaseUrl: string
  token: string
  initialConcepts: CanvasConcept[]
}

export function ConceptPanel({ canvasId, apiBaseUrl, token, initialConcepts }: ConceptPanelProps) {
  const [concepts, setConcepts] = useState<CanvasConcept[]>(initialConcepts)
  const [openSpanId, setOpenSpanId] = useState<string | null>(null)
  const [detail, setDetail] = useState<SpanContext | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)

  const open = useCallback(
    async (spanId: string, quote: string | null) => {
      setOpenSpanId(spanId)
      setDetail(null)
      setError(null)
      setLoading(true)
      try {
        // 把引文一并送过去：要标黄的是这一句，不是整个 span（M2 的 span 是整页一片）
        const suffix = quote ? `?quote=${encodeURIComponent(quote)}` : ''
        const response = await fetch(`${apiBaseUrl}/v1/spans/${spanId}/context${suffix}`, {
          headers: { authorization: `Bearer ${token}` },
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok) {
          setError(payload?.error?.message ?? `HTTP ${response.status}`)
          return
        }
        setDetail(payload as SpanContext)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLoading(false)
      }
    },
    [apiBaseUrl, token],
  )

  const close = useCallback(() => {
    setOpenSpanId(null)
    setDetail(null)
    setError(null)
  }, [])

  // Esc 关闭；焦点给关闭按钮，键盘用户不会困在抽屉里
  useEffect(() => {
    if (!openSpanId) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [openSpanId, close])

  const reload = useCallback(async () => {
    const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/concepts`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!response.ok) return
    const payload = (await response.json()) as { concepts: CanvasConcept[] }
    setConcepts(payload.concepts)
  }, [canvasId, token])

  return (
    <section data-testid="concept-panel" style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700 }}>概念卡</h2>
          <span data-testid="concept-count" style={{ fontSize: 12, color: '#6b7280' }}>
            共 {concepts.length} 张
          </span>
          <button
            type="button"
            onClick={reload}
            style={{ marginLeft: 'auto', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, padding: '2px 8px', background: '#fff' }}
          >
            刷新
          </button>
        </div>

        {concepts.length === 0 && (
          <p data-testid="concept-empty" style={{ fontSize: 13, color: '#9ca3af' }}>
            这个画布还没有概念卡。跑通 文件解析 → 语义切片 → 概念抽取 → 概念卡 之后会出现在这里。
          </p>
        )}

        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {concepts.map((concept) => {
            const tone = STATUS_TONE[concept.status] ?? STATUS_TONE.UNVERIFIED!
            return (
              <li
                key={concept.id}
                data-testid="concept-card"
                data-concept-status={concept.status}
                style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px', background: '#fff' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 14 }}>{concept.name}</strong>
                  <span
                    data-testid="concept-status"
                    style={{ fontSize: 11, color: tone.color, background: tone.bg, borderRadius: 999, padding: '1px 8px' }}
                  >
                    {tone.label}
                  </span>
                  {concept.reviewedBy && (
                    <span style={{ fontSize: 11, color: '#6b7280' }}>人工复核</span>
                  )}
                </div>
                <p style={{ fontSize: 13, color: '#374151', margin: '6px 0' }}>{concept.definition}</p>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {concept.citations.length === 0 ? (
                    <span data-testid="no-citation" style={{ fontSize: 11, color: '#b91c1c' }}>
                      无引用
                    </span>
                  ) : (
                    concept.citations.map((citation, index) => (
                      <button
                        key={citation.id}
                        type="button"
                        data-testid="citation-badge"
                        data-span-id={citation.spanId}
                        onClick={() => open(citation.spanId, citation.quote)}
                        title={`${citation.quote ?? ''}\n第 ${citation.page} 页 · 字符 ${citation.charStart}–${citation.charEnd}`}
                        style={{
                          fontSize: 11,
                          border: '1px solid #bfdbfe',
                          background: openSpanId === citation.spanId ? '#dbeafe' : '#eff6ff',
                          color: '#1d4ed8',
                          borderRadius: 999,
                          padding: '1px 8px',
                          cursor: 'pointer',
                        }}
                      >
                        [{index + 1}] 第{citation.page}页
                      </button>
                    ))
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      {openSpanId && (
        <aside
          data-testid="provenance-drawer"
          aria-label="溯源抽屉"
          style={{
            width: 380,
            flex: '0 0 380px',
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            background: '#fff',
            padding: 12,
            position: 'sticky',
            top: 12,
            maxHeight: '70vh',
            overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 13 }}>原文溯源</strong>
            <button
              ref={closeRef}
              type="button"
              onClick={close}
              data-testid="drawer-close"
              style={{ marginLeft: 'auto', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, padding: '2px 8px', background: '#fff' }}
            >
              关闭
            </button>
          </div>

          {loading && <p style={{ fontSize: 12, color: '#6b7280' }}>加载中…</p>}
          {error && (
            <p data-testid="drawer-error" style={{ fontSize: 12, color: '#b91c1c' }}>
              读取失败：{error}
            </p>
          )}

          {detail && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <div style={{ color: '#6b7280', marginBottom: 6 }}>
                {detail.filename} · 第 {detail.page} 页 · {detail.region} · 字符 {detail.charStart}–{detail.charEnd}
              </div>

              {detail.pageText === null ? (
                <p data-testid="drawer-no-text" style={{ color: '#b45309', background: '#fffbeb', padding: 8, borderRadius: 6 }}>
                  {REASON_TEXT[detail.reason ?? ''] ?? `原文不可用（${detail.reason}）`}
                </p>
              ) : (
                detail.context && (
                  <div
                    data-testid="drawer-page-text"
                    style={{
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: 12,
                      lineHeight: 1.7,
                      background: '#f9fafb',
                      borderRadius: 6,
                      padding: 8,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {detail.context.truncatedBefore && <span style={{ color: '#9ca3af' }}>…</span>}
                    {detail.context.text.slice(0, detail.context.highlightStart)}
                    <mark
                      data-testid="drawer-highlight"
                      style={{ background: '#fde68a', padding: '0 1px', borderRadius: 3 }}
                    >
                      {detail.context.text.slice(detail.context.highlightStart, detail.context.highlightEnd)}
                    </mark>
                    {detail.context.text.slice(detail.context.highlightEnd)}
                    {detail.context.truncatedAfter && <span style={{ color: '#9ca3af' }}>…</span>}
                  </div>
                )
              )}

              <div style={{ marginTop: 8, color: '#6b7280' }}>引文（模型给出的原句）</div>
              <blockquote
                data-testid="drawer-quote"
                style={{ margin: '4px 0 0', paddingLeft: 8, borderLeft: '3px solid #d1d5db', color: '#374151' }}
              >
                {detail.quote}
              </blockquote>
            </div>
          )}
        </aside>
      )}
    </section>
  )
}
