'use client'

import { ModelControls, useModelControls } from './CanvasAiConfig'

import { MathText } from '../MathText'

import { useEffect, useRef, useState } from 'react'

import { ThinkingBubble } from './ThinkingBubble'

/**
 * 单个节点的对话面板。
 *
 * 每个节点本身就是一个会话：它带着自己的产物当上下文，
 * 你可以问"这条定义为什么这么写""这一步为什么成立"。
 *
 * 记录以服务端 NodeMessage 为准，读取失败不能把空列表当成真实历史。
 */

interface Turn {
  role: 'user' | 'assistant'
  text: string
}


export function NodeChat({
  nodeId,
  nodeTitle,
  nodeType,
  apiBaseUrl,
  token,
  onClose,
  track,
  waitForWrites,
  rememberFailure,
}: {
  nodeId: string
  nodeTitle: string
  nodeType: string
  apiBaseUrl: string
  token: string
  onClose: () => void
  track: (p: Promise<void>) => void
  waitForWrites: () => Promise<unknown>
  rememberFailure: (turn:string, retry:() => Promise<void>) => void
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [thinking, setThinking] = useState<string | null>(null)
  const [ready, setReady] = useState(false), [error, setError] = useState(''), [attempt,setAttempt] = useState(0)
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let active = true
    async function load() {
      // 面板重新打开时，先等本画布中在途的节点回复落库。
      await waitForWrites()
      const r = await fetch(`${apiBaseUrl}/v1/nodes/${nodeId}/messages`, { headers: { authorization: `Bearer ${token}` }, cache:'no-store' })
      if (!r.ok) throw Error(`读取节点对话失败：HTTP ${r.status}`)
      const data = await r.json(); if (!active) return
      setTurns(data.messages.map((m: {role: Turn['role']; content: string}) => ({role:m.role,text:m.content})))
      setError(''); setReady(true)
    }
    void load().catch(e => { if (active) setError(String(e)) }); return () => {active=false}
  }, [nodeId,apiBaseUrl,token,attempt])
  useEffect(() => { bottom.current?.scrollIntoView({block:'nearest'}) }, [turns])
  const { flush: flushModel } = useModelControls()
  async function send() {
    const message = input.trim()
    if (!message || busy || !ready) return
    setBusy(true)
    setInput('')
    setThinking(null)
    setTurns((prev) => [...prev, { role: 'user', text: message }])
    const turnId = crypto.randomUUID()
    const deliver = async () => {
      await flushModel()
      // 历史由服务端从库里取：客户端再传一份只会和真正用于下游的版本分叉
      const response = await fetch(`${apiBaseUrl}/v1/nodes/${nodeId}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ message, turnId }),
      })
      const data = (await response.json()) as { reply?: string; thinking?: string; error?: { message?: string } }
      if (!response.ok || data.reply === undefined) throw Error(data.error?.message ?? `HTTP ${response.status}`)
      if (typeof data.thinking === 'string') setThinking(data.thinking)
      setTurns((prev) => [
        ...prev,
        { role: 'assistant', text: data.reply ?? data.error?.message ?? `请求失败：HTTP ${response.status}` },
      ])
    }
    try { await deliver() } catch (error) {
      setError(`未确认回复：${String(error)}`)
      rememberFailure(turnId, deliver)
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
        <div style={{ fontSize: 13, fontWeight: 600 }}><MathText>{nodeTitle || nodeType}</MathText></div>
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

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, alignContent: 'start' }}>
        {turns.length === 0 && (
          <p style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.7 }}>
            就这个节点里的内容提问。比如：
            <br />· 这条定义的关键在哪？
            <br />· 这几步之间有没有跳跃？
            <br />· 帮我把这段整理成卡片上的一句话。
          </p>
        )}
        {error && <p role="alert">{error} <button onClick={() => setAttempt(n => n+1)}>重新读取</button></p>}
        {busy && <ThinkingBubble thinking={thinking} />}
        {turns.map((turn, index) => (
          <div
            key={index}
            data-testid={`node-chat-${turn.role}`}
            style={{
              justifySelf: turn.role === 'user' ? 'end' : 'start',
              minWidth: 0, maxWidth: '92%',
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
            <MathText>{turn.text}</MathText>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <ModelControls task="method" scope={`chat:${nodeId}`} label="对话模型" />
      <div style={{ display: 'flex', gap: 6, padding: 10, borderTop: '1px solid #e2e8f0' }}>
        <input
          data-testid="node-chat-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              track(send())
            }
          }}
          placeholder="就这个节点问点什么…"
          style={{ flex: 1, border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 10px', fontSize: 13, outline: 'none' }}
        />
        <button
          type="button"
          data-testid="node-chat-send"
          disabled={!ready || busy || !input.trim()}
          onClick={() => track(send())}
          style={{ border: 'none', background: busy ? '#93c5fd' : '#2563eb', color: '#fff', borderRadius: 8, padding: '7px 12px', fontSize: 13, cursor: busy ? 'wait' : 'pointer' }}
        >
          {busy ? '…' : '问'}
        </button>
      </div>
    </aside>
  )
}
