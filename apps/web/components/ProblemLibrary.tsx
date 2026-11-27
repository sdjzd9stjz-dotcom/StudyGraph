'use client'

import { MathText } from './MathText'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export interface ProblemItem {
  id: string
  type: string
  stem: string
  options: unknown
  answer: unknown
  judgeRule: string
  difficulty: number
  bloom: string
  status: string
  rejectReason?: string | null
  checkResult: unknown
  attempts: number
  concepts: Array<{ id: string; name: string }>
}

const TYPE_LABEL: Record<string, string> = {
  SINGLE_CHOICE: '单选',
  MULTI_CHOICE: '多选',
  TRUE_FALSE: '判断',
  FILL_BLANK: '填空',
  NUMERIC: '数值',
  COMPUTATION: '计算',
  SHORT_ANSWER: '简答',
  PROOF: '证明',
}

const STATUS_COLOR: Record<string, string> = {
  VERIFIED: '#059669',
  PENDING: '#d97706',
  REJECTED: '#dc2626',
}

/**
 * 题库列表 + 勾选组卷。
 *
 * 题库保留各状态供查看，只有 VERIFIED 可以提交组卷。
 */
export function ProblemLibrary({
  canvasId,
  problems,
  apiBaseUrl,
  token,
}: {
  canvasId: string
  problems: ProblemItem[]
  apiBaseUrl: string
  token: string
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const toggle = (id: string, selectable: boolean) => {
    if (!selectable) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const eligible = new Set(problems.filter(problem => problem.status === 'VERIFIED').map(problem => problem.id))
  const selectedIds = [...selected].filter(id => eligible.has(id))
  async function assemble() {
    if (selectedIds.length === 0) return
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch(`${apiBaseUrl}/v1/papers/assemble`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ problemIds: selectedIds, title: `手工组卷 ${new Date().toLocaleDateString('zh-CN')}` }),
      })
      const body = (await response.json().catch(() => null)) as
        | { id?: string; itemCount?: number; totalPoints?: number; error?: { message?: string } }
        | null
      if (!response.ok) {
        router.refresh()
        setMessage({ ok: false, text: body?.error?.message ?? `组卷失败：HTTP ${response.status}` })
        return
      }
      setMessage({ ok: true, text: `✓ 已组卷：${body?.itemCount} 道题，共 ${body?.totalPoints} 分` })
      setSelected(new Set())
      router.refresh()
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  if (problems.length === 0) {
    return (
      <div data-testid="problems-empty" style={{ border: '1px dashed #d1d5db', borderRadius: 8, padding: 24, color: '#9ca3af', fontSize: 13 }}>
        这张画布还没有题。在画布上跑「出题」节点，新题会以待质检状态进入题库。
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <span style={{ fontSize: 12, color: '#6b7280' }}>仅 VERIFIED 题目可组卷 · 已选 {selectedIds.length} 道</span>
        <button
          type="button"
          data-testid="assemble-paper"
          disabled={busy || selectedIds.length === 0}
          onClick={() => void assemble()}
          style={{
            padding: '5px 14px',
            borderRadius: 6,
            border: 'none',
            background: selectedIds.length === 0 ? '#cbd5e1' : '#2563eb',
            color: '#fff',
            fontSize: 13,
            cursor: selectedIds.length === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? '组卷中…' : '用选中的题组卷'}
        </button>
        {message && (
          <span data-testid="assemble-message" style={{ fontSize: 12, color: message.ok ? '#059669' : '#dc2626' }}>
            {message.text}
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {problems.map((problem) => {
          const selectable = eligible.has(problem.id)
          const checked = selectable && selected.has(problem.id)
          return (
            <div
              key={problem.id}
              data-testid={`problem-${problem.id}`}
              data-status={problem.status}
              onClick={() => toggle(problem.id, selectable)}
              style={{
                border: `1px solid ${checked ? '#2563eb' : '#e5e7eb'}`,
                background: checked ? '#eff6ff' : '#fff',
                borderRadius: 8,
                padding: 12,
                cursor: selectable ? 'pointer' : 'not-allowed',
                opacity: selectable ? 1 : 0.5,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <input type="checkbox" checked={checked} disabled={!selectable} readOnly style={{ cursor: 'inherit' }} />
                <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 999, background: '#f1f5f9', color: '#475569' }}>
                  {TYPE_LABEL[problem.type] ?? problem.type}
                </span>
                <span style={{ fontSize: 11, color: STATUS_COLOR[problem.status] ?? '#9ca3af' }}>{problem.status}</span>
                <span style={{ fontSize: 11, color: '#9ca3af' }}>难度 {problem.difficulty}</span>
                {problem.attempts > 0 && <span style={{ fontSize: 11, color: '#9ca3af' }}>已作答 {problem.attempts} 次</span>}
              </div>

              <div style={{ fontSize: 13, color: '#1f2937', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}><MathText>{problem.stem}</MathText></div>

              {problem.status === 'REJECTED' && problem.rejectReason && (
                <div style={{ marginTop: 6, fontSize: 12, color: '#991b1b' }}>驳回理由：<MathText>{problem.rejectReason}</MathText></div>
              )}

              {problem.concepts.length > 0 && (
                <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {problem.concepts.map((concept) => (
                    <span key={concept.id} style={{ fontSize: 10, color: '#6366f1', background: '#eef2ff', borderRadius: 4, padding: '1px 6px' }}>
                      <MathText>{concept.name}</MathText>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
