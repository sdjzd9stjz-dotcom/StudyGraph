'use client'

import { useEffect, useRef, useState } from 'react'

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

interface Turn {
  id: string
  role: 'user' | 'assistant'
  text: string
  actions?: AssistantAction[]
  applied?: boolean
  source?: string
}

/**
 * 底部 AI 对话栏。
 *
 * 能做的事：
 *   · 读画布现状，回答"我现在到哪一步了"
 *   · **一次铺一整张图**（主链 + 出题支线 + 解题支线 + 闸门），不是一次只加一个节点
 *   · 多轮追加：第二句"再加个出题"只补缺的部分，已有节点不重复建
 *   · 把整段对话留在面板里，刷新/应用后也还在
 * 不能做的事：**自动执行节点**。应用之后节点是 DRAFT，必须用户自己点 ▶。
 * 这不是能力不足：执行会真的花掉模型额度，必须由人发起。
 */
const THREAD_PREFIX = 'studygraph:assistant:'

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
  const [thread, setThread] = useState<Turn[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  /**
   * 聊天记录存 sessionStorage。
   *
   * 为什么要存：应用建议后画布会刷新，组件可能重新挂载 ——
   * 记录只放在内存里就会在"刚铺完图"的时候消失，用户正想回看刚才说了什么。
   * 用 sessionStorage 而不是 localStorage：关掉窗口就该忘掉，不该留到下次。
   */
  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(THREAD_PREFIX + canvasId)
      if (!saved) return
      const parsed = JSON.parse(saved) as Turn[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        setThread(parsed)
        setOpen(true)
      }
    } catch {
      // 存坏的记录直接忽略，不要为了一条历史让整个画布白屏
    }
  }, [canvasId])

  useEffect(() => {
    try {
      window.sessionStorage.setItem(THREAD_PREFIX + canvasId, JSON.stringify(thread.slice(-40)))
    } catch {
      // 隐私模式下写不进去：不影响当前会话
    }
    bottomRef.current?.scrollIntoView({ block: 'nearest' })
  }, [canvasId, thread])

  async function send() {
    const message = input.trim()
    if (!message || busy) return
    setOpen(true)
    setBusy(true)
    setInput('')

    // 把最近的几轮一起带上，模型才知道"再"指的是什么
    const history = thread.slice(-6).map((turn) => ({ role: turn.role, text: turn.text }))
    setThread((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', text: message }])

    try {
      const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ message, history }),
      })
      const data = (await response.json()) as AssistantReply & { error?: { message?: string } }
      if (!response.ok) {
        setThread((prev) => [
          ...prev,
          { id: `a-${Date.now()}`, role: 'assistant', text: data?.error?.message ?? `请求失败：HTTP ${response.status}` },
        ])
        return
      }
      setThread((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: 'assistant', text: data.reply, actions: data.actions, source: data.source },
      ])
    } catch (error) {
      setThread((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: 'assistant', text: `出错了：${error instanceof Error ? error.message : String(error)}` },
      ])
    } finally {
      setBusy(false)
    }
  }

  async function apply(id: string, actions: AssistantAction[]) {
    setBusy(true)
    try {
      const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/assistant/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ actions }),
      })
      if (!response.ok) {
        setThread((prev) => [
          ...prev,
          { id: `a-${Date.now()}`, role: 'assistant', text: `应用失败：HTTP ${response.status}` },
        ])
        return
      }
      const result = (await response.json()) as { nodes: number; edges: number }
      setThread((prev) =>
        prev.map((turn) =>
          turn.id === id
            ? { ...turn, applied: true, text: `${turn.text}\n\n✓ 已落地 ${result.nodes} 个节点、${result.edges} 条连线（都是草稿，需要你逐个点 ▶）` }
            : turn,
        ),
      )
      onApplied()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="assistant-bar" style={{ borderTop: '1px solid #e2e8f0', background: '#fff' }}>
      {open && (
        <div
          data-testid="assistant-thread"
          style={{ maxHeight: 300, overflowY: 'auto', padding: '10px 14px', display: 'grid', gap: 10 }}
        >
          {thread.length === 0 && (
            <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.7 }}>
              说一句要做的事，我一次把整张图铺好 —— 但**不会替你运行**。
              <br />
              例如：「把课件变成知识卡并出题」「再加一条解题支线」「我要完整的图」
            </div>
          )}

          {thread.map((turn) => (
            <div
              key={turn.id}
              data-testid={`assistant-msg-${turn.role}`}
              style={{
                justifySelf: turn.role === 'user' ? 'end' : 'start',
                maxWidth: '86%',
                background: turn.role === 'user' ? '#eff6ff' : '#f8fafc',
                border: `1px solid ${turn.role === 'user' ? '#bfdbfe' : '#e2e8f0'}`,
                borderRadius: 10,
                padding: '7px 11px',
                fontSize: 13,
              }}
            >
              <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 3 }}>
                {turn.role === 'user' ? '你' : 'AI'}
                {turn.source === 'model' ? ' · 模型规划' : turn.role === 'assistant' && turn.actions ? ' · 规则规划' : ''}
              </div>
              <div style={{ color: '#334155', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{turn.text}</div>

              {turn.actions && turn.actions.length > 0 && !turn.applied && (
                <button
                  type="button"
                  data-testid={`apply-actions-${turn.id}`}
                  disabled={busy}
                  onClick={() => void apply(turn.id, turn.actions!)}
                  style={{
                    marginTop: 8,
                    fontSize: 12,
                    border: 'none',
                    color: '#fff',
                    background: busy ? '#93c5fd' : '#2563eb',
                    borderRadius: 6,
                    padding: '4px 12px',
                    cursor: busy ? 'wait' : 'pointer',
                  }}
                >
                  应用到画布（{turn.actions.length} 步）
                </button>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, padding: '8px 12px', alignItems: 'center' }}>
        <button
          type="button"
          data-testid="toggle-assistant"
          title={open ? '收起对话' : '展开对话记录'}
          onClick={() => setOpen((value) => !value)}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, color: '#64748b' }}
        >
          {open ? '▾' : '▸'} {thread.length > 0 ? `对话 ${thread.length}` : ''}
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
          placeholder="让它铺图，或问节点里的内容：「这些概念里哪个最难？」"
          style={{ flex: 1, border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none' }}
        />
        {thread.length > 0 && (
          <button
            type="button"
            data-testid="clear-assistant"
            onClick={() => setThread([])}
            title="清空对话记录"
            style={{ border: '1px solid #e2e8f0', background: '#fff', color: '#64748b', borderRadius: 8, padding: '7px 10px', fontSize: 12, cursor: 'pointer' }}
          >
            清空
          </button>
        )}
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
