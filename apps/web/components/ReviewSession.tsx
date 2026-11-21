'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import type { DueItem } from '../lib/api'

const GRADES = [
  { value: 'AGAIN', label: '忘了', hint: '完全想不起来', color: '#dc2626' },
  { value: 'HARD', label: '勉强', hint: '想起来了但很吃力', color: '#d97706' },
  { value: 'GOOD', label: '记得', hint: '正常回忆', color: '#059669' },
  { value: 'EASY', label: '太简单', hint: '一看就会', color: '#2563eb' },
] as const

/**
 * 复习会话：一张一张过，评完立刻排下一次。
 *
 * 为什么不做成"一次性提交整批"：FSRS 的下一次间隔取决于**这一次**的评分，
 * 批量提交会让「第 3 张其实是在第 1 张之后几分钟才答的」这种时间信息丢失。
 */
export function ReviewSession({ items, apiBaseUrl, token }: { items: DueItem[]; apiBaseUrl: string; token: string }) {
  const router = useRouter()
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Array<{ name: string; grade: string; days: number }>>([])

  const current = items[index]

  async function grade(value: string) {
    if (!current) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`${apiBaseUrl}/v1/concepts/${current.id}/grade`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ grade: value }),
      })
      const body = (await response.json().catch(() => null)) as
        | { scheduledDays?: number; error?: { message?: string } }
        | null
      if (!response.ok) {
        setError(body?.error?.message ?? `HTTP ${response.status}`)
        return
      }
      setDone((prev) => [...prev, { name: current.name, grade: value, days: body?.scheduledDays ?? 0 }])
      setIndex((prev) => prev + 1)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  if (items.length === 0) {
    return (
      <div data-testid="review-empty" style={{ padding: 24, border: '1px solid #e5e7eb', borderRadius: 8 }}>
        <p style={{ color: '#6b7280' }}>今天没有到期的卡片。</p>
        <Link href="/" style={{ color: '#2563eb', fontSize: 13 }}>
          返回首页
        </Link>
      </div>
    )
  }

  if (!current) {
    return (
      <div data-testid="review-done" style={{ padding: 24, border: '1px solid #e5e7eb', borderRadius: 8 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>今天复习完了</h2>
        <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 12 }}>共复习 {done.length} 张。</p>
        <ul style={{ listStyle: 'none', padding: 0, fontSize: 13, display: 'grid', gap: 6 }}>
          {done.map((entry, i) => (
            <li key={`${entry.name}-${i}`} style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: '#6b7280' }}>{entry.name}</span>
              <span style={{ color: '#9ca3af' }}>
                {GRADES.find((g) => g.value === entry.grade)?.label} · {formatDays(entry.days)}后再见
              </span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => router.refresh()}
          style={{ marginTop: 16, padding: '6px 14px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer' }}
        >
          看看还有没有
        </button>
      </div>
    )
  }

  return (
    <div data-testid="review-card" style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>
          {index + 1} / {items.length}
        </span>
        <span style={{ fontSize: 12, color: current.isNew ? '#2563eb' : '#9ca3af' }}>
          {current.isNew ? '新卡' : `已复习 ${current.reps} 次`}
        </span>
        <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 'auto' }}>{current.canvasTitle}</span>
      </div>

      <h2 data-testid="review-name" style={{ fontSize: 22, fontWeight: 700, marginBottom: 10 }}>
        {current.name}
      </h2>
      <p style={{ fontSize: 15, lineHeight: 1.7, color: '#374151', marginBottom: 24 }}>{current.definition}</p>

      {error && (
        <p data-testid="review-error" style={{ fontSize: 13, color: '#dc2626', marginBottom: 12 }}>
          {error}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        {GRADES.map((gradeOption) => (
          <button
            key={gradeOption.value}
            type="button"
            disabled={busy}
            data-testid={`grade-${gradeOption.value}`}
            onClick={() => grade(gradeOption.value)}
            title={gradeOption.hint}
            style={{
              flex: 1,
              padding: '10px 8px',
              borderRadius: 8,
              border: `1px solid ${gradeOption.color}`,
              background: '#fff',
              color: gradeOption.color,
              cursor: busy ? 'wait' : 'pointer',
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            {gradeOption.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function formatDays(days: number): string {
  if (days < 1) return `${Math.round(days * 24 * 60)} 分钟`
  if (days < 30) return `${Math.round(days)} 天`
  return `${(days / 30).toFixed(1)} 个月`
}
