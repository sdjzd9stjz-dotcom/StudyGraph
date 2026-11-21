'use client'

import { useState } from 'react'

export interface AssistantAction {
  kind: string
  payload: Record<string, unknown>
}

export interface AssistantReply {
  reply: string
  actions: AssistantAction[]
  source: string
  executed?: boolean
}

/**
 * 底部 AI 对话栏（用户要求）。
 *
 * 能做：读画布、提议建节点与连线、提议绑定 skill、应用到画布。
 * **不能做**：自动执行节点 —— 应用之后节点是 DRAFT，要用户自己点运行。
 * 这不是能力不足，是刻意的：执行会花用户的模型额度，必须由人发起。
 */
export function AssistantBar({
  canvasId,
  apiBaseUrl,
  token,
  onApplied,
}: {
  canvasId: string
  apiBaseUrl: string
  token: string
  onApplied: () => void
}) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [thread, setThread] = useState<Array<{ role: 'user' | 'assistant'; text: string; actions?: AssistantAction[]; applied?: boolean }>>([])

  async function send() {
    const message = input.trim()
    if (!message || busy) return
    // 发送时必须展开面板：否则回复渲染在 {open && …} 里，用户什么都看不到
    setOpen(true)
    setBusy(true)
    setInput('')
    setThread((prev) => [...prev, { role: 'user', text: message }])
    try {
      const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ message }),
      })
      const data = (await response.json()) as AssistantReply
      setThread((prev) => [...prev, { role: 'assistant', text: data.reply, actions: data.actions }])
    } catch (error) {
      setThread((prev) => [...prev, { role: 'assistant', text: `出错了：${error instanceof Error ? error.message : String(error)}` }])
    } finally {
      setBusy(false)
    }
  }

  async function apply(index: number, actions: AssistantAction[]) {
    setBusy(true)
    try {
      const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/assistant/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ actions }),
      })
      if (response.ok) {
        setThread((prev) => prev.map((entry, i) => (i === index ? { ...entry, applied: true } : entry)))
        onApplied()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="assistant-bar" style={{ borderTop: '1px solid #e2e8f0', background: '#fff' }}>
      {open && (
        <div style={{ maxHeight: 260, overflowY: 'auto', padding: '10px 14px', display: 'grid', gap: 8 }}>
          {thread.length === 0 && (
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              试试：「把课件做成知识卡」「给我的画布加严格溯源」「下一步做什么」
            </div>
          )}
          {thread.map((entry, index) => (
            <div key={index} data-testid={`assistant-msg-${entry.role}`} style={{ fontSize: 13 }}>
              <span style={{ color: entry.role === 'user' ? '#2563eb' : '#475569', fontWeight: 600 }}>
                {entry.role === 'user' ? '你' : 'AI'}：
              </span>
              <span style={{ color: '#334155', whiteSpace: 'pre-wrap' }}>{entry.text}</span>
              {entry.actions && entry.actions.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {entry.applied ? (
                    <span style={{ fontSize: 11, color: '#059669' }}>✓ 已应用到画布（节点是草稿，需逐个运行）</span>
                  ) : (
                    <button
                      type="button"
                      data-testid={`apply-actions-${index}`}
                      disabled={busy}
                      onClick={() => apply(index, entry.actions!)}
                      style={{ fontSize: 11, border: '1px solid #2563eb', color: '#2563eb', background: '#fff', borderRadius: 5, padding: '3px 10px', cursor: 'pointer' }}
                    >
                      应用到画布（{entry.actions.length} 步）
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, padding: '8px 12px', alignItems: 'center' }}>
        <button
          type="button"
          data-testid="toggle-assistant"
          onClick={() => setOpen((value) => !value)}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, color: '#64748b' }}
        >
          {open ? '▾' : '▸'}
        </button>
        <input
          data-testid="assistant-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          onFocus={() => setOpen(true)}
          placeholder="告诉 AI 你想做什么，例如：把课件做成知识卡"
          style={{ flex: 1, border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none' }}
        />
        <button
          type="button"
          data-testid="assistant-send"
          disabled={busy || !input.trim()}
          onClick={() => void send()}
          style={{ border: 'none', background: busy ? '#93c5fd' : '#2563eb', color: '#fff', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: busy ? 'wait' : 'pointer' }}
        >
          {busy ? '…' : '发送'}
        </button>
      </div>
    </div>
  )
}
