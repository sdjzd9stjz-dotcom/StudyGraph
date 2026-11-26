'use client'

import { MathText } from '../MathText'

import { useEffect, useRef, useState } from 'react'

import { ThinkingBubble } from './ThinkingBubble'

export interface CanvasChange {
  kind: 'create-node' | 'update-node' | 'delete-node' | 'create-edge' | 'delete-edge'
  id: string
  label: string
}

export interface AssistantReply {
  reply: string
  changes: CanvasChange[]
  source: string
  model?: string | null
  thinking?: string | null
}
interface Turn { id: string; role: 'user' | 'assistant'; text: string; changes?: CanvasChange[]; model?: string | null; source?: string }
const THREAD_PREFIX = 'studygraph:assistant:'

export function AssistantBar({canvasId, apiBaseUrl, token, onApplied, flushRef}: {
  canvasId: string; apiBaseUrl: string; token: string; onApplied: () => Promise<void>; flushRef: {current: () => Promise<void>}
}) {
  const [open,setOpen] = useState(false), [input,setInput] = useState(''), [busy,setBusy] = useState(false)
  const [thinking, setThinking] = useState<string | null>(null)
  const [thread, setThread] = useState<Turn[]>([])
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const current = useRef<Turn[]>([]), acknowledged = useRef(current.current), revision = useRef(0)
  const tail = useRef(Promise.resolve()), sending = useRef<Promise<void> | null>(null)
  const endpoint = `${apiBaseUrl}/v1/canvases/${canvasId}/assistant/thread`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  function persist() {
    const save = tail.current.then(async () => {
      const messages = current.current
      if (messages === acknowledged.current) return
      const previous = acknowledged.current
      const append = messages.length >= previous.length && previous.every((m,i) => m === messages[i])
      const r = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify({ messages: append ? messages.slice(previous.length) : messages, append, revision: revision.current }) })
      const body = await r.json(); if (!r.ok) {
        // 回包丢失不等于写入失败。只认相同记录，绝不静默覆盖另一窗口的新消息。
        if (r.status !== 409) throw Error(body.error?.message ?? `HTTP ${r.status}`)
        const read = await fetch(endpoint,{headers,cache:'no-store'}); if (!read.ok) throw Error(`读取对话失败：HTTP ${read.status}`)
        const remote = await read.json()
        if (remote.messages.length !== messages.length || !messages.every((m,i) => m.id === remote.messages[i].id && m.text === remote.messages[i].text)) throw Error(body.error?.message ?? '对话已变更')
        body.revision = remote.revision
      }
      revision.current = body.revision; acknowledged.current = messages; setError('')
      try { sessionStorage.removeItem(THREAD_PREFIX + canvasId) } catch {}
    })
    tail.current = save.catch(e => setError(String(e)))
    return save
  }
  function update(fn: (prev: Turn[]) => Turn[]) {
    current.current = fn(current.current); setThread(current.current)
    void persist().catch(() => {})
  }
  useEffect(() => {
    let active = true
    async function load() {
      const r = await fetch(endpoint, { headers, cache: 'no-store' }); if (!r.ok) throw Error(`读取对话失败：HTTP ${r.status}`)
      const body = await r.json(); if (!active) return
      revision.current = body.revision; current.current = acknowledged.current = body.messages
      let legacy: Turn[] | undefined
      try { legacy = JSON.parse(sessionStorage.getItem(THREAD_PREFIX + canvasId) ?? 'null') } catch {}
      if (!body.revision && Array.isArray(legacy) && legacy.length) update(() => legacy!)
      setThread(current.current); setOpen(current.current.length > 0); setReady(true)
    }
    void load().catch(e => { if (active) setError(String(e)) }); return () => { active = false }
  }, [endpoint, token, attempt])
  useEffect(() => { bottomRef.current?.scrollIntoView({block:'nearest'}) }, [thread])
  flushRef.current = async () => { await sending.current; await persist() }
  function submit() {
    if (!ready || sending.current) return
    sending.current = send().finally(() => { sending.current = null })
  }
  async function send() {
    const message = input.trim()
    if (!message || busy) return
    setOpen(true)
    setBusy(true)
    setInput('')
    setThinking(null)

    // 把最近的几轮一起带上，模型才知道"再"指的是什么
    const history = thread.slice(-6).map((turn) => ({ role: turn.role, text: turn.text.slice(0,4000) }))
    update((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', text: message }])

    try {
      const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ message, history }),
      })
      const data = (await response.json()) as AssistantReply & { error?: { message?: string } }
      if (!response.ok) {
        update((prev) => [
          ...prev,
          { id: `a-${Date.now()}`, role: 'assistant', text: data?.error?.message ?? `请求失败：HTTP ${response.status}` },
        ])
        return
      }
      if (typeof data.thinking === 'string') setThinking(data.thinking)
      const changes = Array.isArray(data.changes) ? data.changes : []
      update((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: 'assistant', text: data.reply, changes, source: data.source, model: data.model ?? null },
      ])
      // 模型已经直接改过画布了：刷新一次，让用户看到节点/连线真的变了
      if (changes.length > 0) await onApplied()
    } catch (error) {
      update((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: 'assistant', text: `出错了：${error instanceof Error ? error.message : String(error)}` },
      ])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="assistant-bar" style={{ borderTop: '1px solid #e2e8f0', background: '#fff' }}>
      {error && <p role="alert">{error} <button onClick={() => ready ? void persist().catch(() => {}) : setAttempt(n => n+1)}>重试</button></p>}
      {open && (
        <div
          data-testid="assistant-thread"
          style={{ maxHeight: 300, overflowY: 'auto', padding: '10px 14px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 }}
        >
          {thread.length === 0 && (
            <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.7 }}>
              直接说要做什么，我用工具改画布（建节点、连线、改提示词）—— 但**不会替你运行节点**。
              <br />
              例如：「把课件做成知识卡并出题」「把抽取节点的提示词改得更严格」「这个画布现在到哪一步了？」
            </div>
          )}

          {thread.map((turn) => (
            <div
              key={turn.id}
              data-testid={`assistant-msg-${turn.role}`}
              style={{
                justifySelf: turn.role === 'user' ? 'end' : 'start',
                minWidth: 0, maxWidth: '86%',
                background: turn.role === 'user' ? '#eff6ff' : '#f8fafc',
                border: `1px solid ${turn.role === 'user' ? '#bfdbfe' : '#e2e8f0'}`,
                borderRadius: 10,
                padding: '7px 11px',
                fontSize: 13,
              }}
            >
              <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 3 }}>
                {turn.role === 'user' ? '你' : 'AI'}
                {turn.source === 'model' ? ` · 你的模型${turn.model ? `（${turn.model}）` : ''}` : ''}
              </div>
              <div style={{ color: '#334155', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}><MathText>{turn.text}</MathText></div>

              {turn.changes && turn.changes.length > 0 && (
                <div data-testid={`assistant-changes-${turn.id}`} style={{ marginTop: 6, fontSize: 11, color: '#059669' }}>
                  ✓ 画布已改动 {turn.changes.length} 处：
                  <MathText>{turn.changes.map((change) => change.label).join('、')}</MathText>
                </div>
              )}
            </div>
          ))}
          {busy && <ThinkingBubble thinking={thinking} />}
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
              submit()
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
            disabled={busy || !ready}
            onClick={() => update(() => [])}
            title="清空对话记录"
            style={{ border: '1px solid #e2e8f0', background: '#fff', color: '#64748b', borderRadius: 8, padding: '7px 10px', fontSize: 12, cursor: 'pointer' }}
          >
            清空
          </button>
        )}
        <button
          type="button"
          data-testid="assistant-send"
          disabled={!ready || busy || !input.trim()}
          onClick={submit}
          style={{ border: 'none', background: busy ? '#93c5fd' : '#2563eb', color: '#fff', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: busy ? 'wait' : 'pointer' }}
        >
          {busy ? '…' : '发送'}
        </button>
      </div>
    </div>
  )
}
