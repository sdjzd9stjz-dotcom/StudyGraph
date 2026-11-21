'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * 单个节点的对话面板。
 *
 * 每个节点本身就是一个会话：它带着自己的产物当上下文，
 * 你可以问"这条定义为什么这么写""这一步为什么成立"。
 *
 * 记录按节点分别存在 sessionStorage 里 —— 关掉窗口就忘掉，
 * 但刷页面、切走再切回来还在。
 */

interface Turn {
  role: 'user' | 'assistant'
  text: string
}

const KEY_PREFIX = 'studygraph:node-chat:'

export function NodeChat({
  nodeId,
  nodeTitle,
  nodeType,
  apiBaseUrl,
  token,
  onClose,
}: {
  nodeId: string
  nodeTitle: string
  nodeType: string
  apiBaseUrl: string
  token: string
  onClose: () => void
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(KEY_PREFIX + nodeId)
      if (saved) setTurns(JSON.parse(saved) as Turn[])
      else setTurns([])
    } catch {
      setTurns([])
    }
  }, [nodeId])

  useEffect(() => {
    try {
      window.sessionStorage.setItem(KEY_PREFIX + nodeId, JSON.stringify(turns.slice(-30)))
    } catch {
      // 隐私模式写不进去：不影响本次会话
    }
    bottom.current?.scrollIntoView({ block: 'nearest' })
  }, [nodeId, turns])

  async function send() {
    const message = input.trim()
    if (!message || busy) return
    setBusy(true)
    setInput('')
    const history = turns.slice(-8)
    setTurns((prev) => [...prev, { role: 'user', text: message }])
    try {
      const response = await fetch(`${apiBaseUrl}/v1/nodes/${nodeId}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ message, history }),
      })
      const data = (await response.json()) as { reply?: string; error?: { message?: string } }
      setTurns((prev) => [
        ...prev,
        { role: 'assistant', text: data.reply ?? data.error?.message ?? `请求失败：HTTP ${response.status}` },
      ])
    } catch (error) {
      setTurns((prev) => [
        ...prev,
        { role: 'assistant', text: `出错了：${error instanceof Error ? error.message : String(error)}` },
      ])
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside
      data-testid="node-chat"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 360,
        background: '#fff',
        borderLeft: '1px solid #e2e8f0',
        boxShadow: '-6px 0 18px rgba(15,23,42,0.06)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 20,
      }}
    >
      <header style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{nodeTitle || nodeType}</div>
        <span style={{ fontSize: 10, color: '#94a3b8' }}>节点对话</span>
        <button
          type="button"
          data-testid="close-node-chat"
          onClick={onClose}
          style={{ marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer', color: '#64748b', fontSize: 14 }}
        >
          ✕
        </button>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'grid', gap: 10, alignContent: 'start' }}>
        {turns.length === 0 && (
          <p style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.7 }}>
            就这个节点里的内容提问。比如：
            <br />· 这条定义的关键在哪？
            <br />· 这几步之间有没有跳跃？
            <br />· 帮我把这段整理成卡片上的一句话。
          </p>
        )}
        {turns.map((turn, index) => (
          <div
            key={index}
            data-testid={`node-chat-${turn.role}`}
            style={{
              justifySelf: turn.role === 'user' ? 'end' : 'start',
              maxWidth: '92%',
              background: turn.role === 'user' ? '#eff6ff' : '#f8fafc',
              border: `1px solid ${turn.role === 'user' ? '#bfdbfe' : '#e2e8f0'}`,
              borderRadius: 10,
              padding: '7px 10px',
              fontSize: 13,
              color: '#334155',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.6,
            }}
          >
            {turn.text}
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <div style={{ display: 'flex', gap: 6, padding: 10, borderTop: '1px solid #e2e8f0' }}>
        <input
          data-testid="node-chat-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder="就这个节点问点什么…"
          style={{ flex: 1, border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 10px', fontSize: 13, outline: 'none' }}
        />
        <button
          type="button"
          data-testid="node-chat-send"
          disabled={busy || !input.trim()}
          onClick={() => void send()}
          style={{ border: 'none', background: busy ? '#93c5fd' : '#2563eb', color: '#fff', borderRadius: 8, padding: '7px 12px', fontSize: 13, cursor: busy ? 'wait' : 'pointer' }}
        >
          {busy ? '…' : '问'}
        </button>
      </div>
    </aside>
  )
}
