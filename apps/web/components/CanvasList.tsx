'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 首页画布列表（用户 2026-11-23 要求）。
 *
 * 四件事：
 *   1. 右键菜单：重命名 / 删除
 *   2. 拖动改变上下顺序（HTML5 拖放，不引拖拽库）
 *   3. 表头冻结：往下翻画布时标题与按钮不动
 *   4. 新建画布时先填名字与 AI 配置
 *
 * 为什么表头要冻结：画布一多，用户滚到第 30 张时看不见"新建画布"在哪，
 * 只能滚回顶部 —— 这是最典型的长列表痛点。
 */

export interface CanvasRow {
  id: string
  title: string
  createdAt: string
  updatedAt?: string
}

interface MenuState {
  id: string
  x: number
  y: number
}

export function CanvasList({
  canvases: initialCanvases,
  apiBaseUrl,
  token,
  dueTotal,
}: {
  canvases: CanvasRow[]
  apiBaseUrl: string
  token: string
  dueTotal: number
}) {
  const router = useRouter()
  const [canvases, setCanvases] = useState<CanvasRow[]>(initialCanvases)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ title: '', model: '', credentialId: '' })
  const [models, setModels] = useState<Array<{ credentialId: string; provider: string; modelId: string }>>([])
  const menuRef = useRef<HTMLDivElement>(null)

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 2600)
  }, [])

  useEffect(() => {
    setCanvases(initialCanvases)
  }, [initialCanvases])

  // 点别处关菜单（菜单本身不算"别处"）
  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenu(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  /** 打开新建对话框时拉一次可用模型，供"画布 AI 配置"下拉使用 */
  const openCreate = useCallback(async () => {
    setCreating(true)
    setDraft({ title: '', model: '', credentialId: '' })
    try {
      const response = await fetch(`${apiBaseUrl}/v1/providers`, { headers: { authorization: `Bearer ${token}` } })
      if (!response.ok) return
      const payload = (await response.json()) as {
        providers: Array<{ slug: string; name: string; credentials: Array<{ id: string }>; models: Array<{ modelId: string; enabled: boolean }> }>
      }
      const options: Array<{ credentialId: string; provider: string; modelId: string }> = []
      for (const provider of payload.providers) {
        for (const credential of provider.credentials) {
          for (const model of provider.models.filter((item) => item.enabled)) {
            options.push({ credentialId: credential.id, provider: provider.name, modelId: model.modelId })
          }
        }
      }
      setModels(options)
    } catch {
      // 拉不到模型不阻塞新建：名字是必需的，模型可以稍后在画布里配
    }
  }, [apiBaseUrl, token])

  const create = useCallback(async () => {
    const title = draft.title.trim()
    if (title.length === 0) {
      notify('请先给画布起个名字')
      return
    }
    setBusy(true)
    try {
      const response = await fetch(`${apiBaseUrl}/v1/canvases`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
        notify(body?.error?.message ?? `创建失败：${response.status}`)
        return
      }
      const canvas = (await response.json()) as { id: string }

      // 选了模型就写成这块画布自己的配置（用户要求 AI 配置每块画布独立）
      if (draft.credentialId && draft.model) {
        await fetch(`${apiBaseUrl}/v1/canvases/${canvas.id}/model-prefs/assistant`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ credentialId: draft.credentialId, modelId: draft.model }),
        }).catch(() => undefined)
      }

      setCreating(false)
      router.push(`/c/${canvas.id}`)
    } finally {
      setBusy(false)
    }
  }, [apiBaseUrl, draft, headers, notify, router, token])

  const rename = useCallback(async (id: string) => {
    const current = canvases.find((canvas) => canvas.id === id)
    const title = window.prompt('画布名称', current?.title ?? '')
    if (title === null) return
    const trimmed = title.trim()
    if (trimmed.length === 0) {
      notify('名字不能为空')
      return
    }
    const response = await fetch(`${apiBaseUrl}/v1/canvases/${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title: trimmed }),
    })
    if (!response.ok) {
      notify(`重命名失败：${response.status}`)
      return
    }
    setCanvases((current) => current.map((canvas) => (canvas.id === id ? { ...canvas, title: trimmed } : canvas)))
    notify('已重命名')
  }, [apiBaseUrl, canvases, headers, notify])

  const remove = useCallback(async (id: string) => {
    const current = canvases.find((canvas) => canvas.id === id)
    // 删除是不可逆的：必须让用户看清要删的是哪一张
    if (!window.confirm(`删除画布「${current?.title ?? id}」？\n\n画布上的节点、课件与产物会一并删除，无法恢复。`)) return
    const response = await fetch(`${apiBaseUrl}/v1/canvases/${id}`, { method: 'DELETE', headers })
    if (!response.ok && response.status !== 204) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
      notify(body?.error?.message ?? `删除失败：${response.status}`)
      return
    }
    setCanvases((current) => current.filter((canvas) => canvas.id !== id))
    notify('已删除')
  }, [apiBaseUrl, canvases, headers, notify])

  /** 松开鼠标：把拖动的项插到目标位置，然后整表提交顺序 */
  const drop = useCallback(async (targetId: string) => {
    const fromId = dragId
    setDragId(null)
    setOverId(null)
    if (!fromId || fromId === targetId) return

    const next = [...canvases]
    const fromIndex = next.findIndex((canvas) => canvas.id === fromId)
    const toIndex = next.findIndex((canvas) => canvas.id === targetId)
    if (fromIndex < 0 || toIndex < 0) return
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved!)
    setCanvases(next)

    const response = await fetch(`${apiBaseUrl}/v1/canvases/order`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ids: next.map((canvas) => canvas.id) }),
    })
    if (!response.ok) notify('顺序保存失败，下次打开可能恢复原顺序')
  }, [apiBaseUrl, canvases, dragId, headers, notify])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* 表头：sticky 固定在顶部，滚动列表时不动 */}
      <header
        data-testid="home-header"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          background: '#fff',
          borderBottom: '1px solid #e2e8f0',
          padding: '14px 32px',
        }}
      >
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 2px' }}>StudyGraph</h1>
          <p style={{ color: '#6b7280', fontSize: 13, margin: '0 0 12px' }}>节点式 AI 学习工作流</p>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              data-testid="create-canvas"
              onClick={() => void openCreate()}
              style={{ border: 'none', background: '#2563eb', color: '#fff', borderRadius: 8, padding: '7px 16px', fontSize: 13, cursor: 'pointer' }}
            >
              新建画布
            </button>
            <span style={{ color: '#9ca3af', fontSize: 13 }}>共 {canvases.length} 张画布</span>
            <Link
              href="/review"
              data-testid="review-entry"
              style={{ color: dueTotal > 0 ? '#2563eb' : '#9ca3af', fontSize: 13, marginLeft: 'auto' }}
            >
              今日到期 {dueTotal}
            </Link>
            <Link href="/problems" style={{ color: '#2563eb', fontSize: 13 }}>题库</Link>
            <Link href="/analytics" style={{ color: '#2563eb', fontSize: 13 }}>错题看板</Link>
            <Link href="/settings" style={{ color: '#2563eb', fontSize: 13 }}>模型供应商</Link>
            <Link href="/guide" data-testid="guide-entry" style={{ color: '#0f766e', fontSize: 13, fontWeight: 600 }}>使用教程</Link>
          </div>
        </div>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 32px 40px' }}>
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 auto', maxWidth: 900, display: 'grid', gap: 8 }}>
          {canvases.map((canvas) => (
            <li
              key={canvas.id}
              data-testid={`canvas-row-${canvas.id}`}
              draggable
              onDragStart={() => setDragId(canvas.id)}
              onDragOver={(event) => {
                event.preventDefault()
                setOverId(canvas.id)
              }}
              onDragLeave={() => setOverId((current) => (current === canvas.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault()
                void drop(canvas.id)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ id: canvas.id, x: event.clientX, y: event.clientY })
              }}
              style={{
                border: `1px solid ${overId === canvas.id ? '#93c5fd' : '#e5e7eb'}`,
                background: overId === canvas.id ? '#eff6ff' : '#fff',
                borderRadius: 8,
                padding: '10px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: 'grab',
                opacity: dragId === canvas.id ? 0.5 : 1,
              }}
            >
              <span style={{ color: '#cbd5e1', fontSize: 13, userSelect: 'none' }}>⠿</span>
              <Link href={`/c/${canvas.id}`} style={{ color: '#2563eb', fontWeight: 600, fontSize: 14 }}>
                {canvas.title}
              </Link>
              <span style={{ color: '#9ca3af', fontSize: 11 }}>{new Date(canvas.createdAt).toLocaleDateString('zh-CN')}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  data-testid={`rename-canvas-${canvas.id}`}
                  onClick={() => void rename(canvas.id)}
                  style={miniButton}
                >
                  重命名
                </button>
                <button
                  type="button"
                  data-testid={`delete-canvas-${canvas.id}`}
                  onClick={() => void remove(canvas.id)}
                  style={{ ...miniButton, color: '#dc2626', borderColor: '#fecaca' }}
                >
                  删除
                </button>
              </span>
            </li>
          ))}
          {canvases.length === 0 && (
            <li style={{ color: '#9ca3af', fontSize: 13 }}>还没有画布，点上面的「新建画布」。</li>
          )}
        </ul>
        {canvases.length > 1 && (
          <p style={{ maxWidth: 900, margin: '14px auto 0', color: '#94a3b8', fontSize: 12 }}>
            提示：拖动可以调整顺序；右键有更多操作。
          </p>
        )}
      </div>

      {menu && (
        <div
          ref={menuRef}
          data-testid="canvas-context-menu"
          style={{
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            zIndex: 100,
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(15,23,42,0.12)',
            padding: 4,
            minWidth: 120,
          }}
        >
          <button type="button" onClick={() => { setMenu(null); void rename(menu.id) }} style={menuItem}>
            重命名
          </button>
          <button
            type="button"
            onClick={() => { setMenu(null); void remove(menu.id) }}
            style={{ ...menuItem, color: '#dc2626' }}
          >
            删除画布
          </button>
        </div>
      )}

      {creating && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'grid', placeItems: 'center', zIndex: 200 }}>
          <div data-testid="create-canvas-dialog" style={{ background: '#fff', borderRadius: 12, padding: 22, width: 420, boxShadow: '0 20px 50px rgba(15,23,42,0.25)' }}>
            <h2 style={{ fontSize: 17, fontWeight: 700, marginTop: 0 }}>新建画布</h2>
            <label style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 4 }}>画布名称</label>
            <input
              autoFocus
              data-testid="create-canvas-title"
              value={draft.title}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              onKeyDown={(event) => { if (event.key === 'Enter') void create() }}
              placeholder="例如：高数 第三章 导数"
              style={{ width: '100%', border: '1px solid #cbd5e1', borderRadius: 8, padding: '8px 10px', fontSize: 13, marginBottom: 14 }}
            />

            <label style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 4 }}>
              这块画布使用的模型（可留空，之后再配）
            </label>
            <select
              data-testid="create-canvas-model"
              value={draft.credentialId && draft.model ? `${draft.credentialId}::${draft.model}` : ''}
              onChange={(event) => {
                const value = event.target.value
                if (!value) {
                  setDraft((current) => ({ ...current, credentialId: '', model: '' }))
                  return
                }
                const [credentialId, model] = value.split('::')
                setDraft((current) => ({ ...current, credentialId: credentialId ?? '', model: model ?? '' }))
              }}
              style={{ width: '100%', border: '1px solid #cbd5e1', borderRadius: 8, padding: '8px 10px', fontSize: 13, marginBottom: 18 }}
            >
              <option value="">使用全局默认</option>
              {models.map((option) => (
                <option key={`${option.credentialId}::${option.modelId}`} value={`${option.credentialId}::${option.modelId}`}>
                  {option.provider} · {option.modelId}
                </option>
              ))}
            </select>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setCreating(false)} style={miniButton}>取消</button>
              <button
                type="button"
                data-testid="create-canvas-confirm"
                disabled={busy}
                onClick={() => void create()}
                style={{ border: 'none', background: busy ? '#93c5fd' : '#2563eb', color: '#fff', borderRadius: 8, padding: '7px 16px', fontSize: 13, cursor: 'pointer' }}
              >
                {busy ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          data-testid="home-toast"
          style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: '#0f172a', color: '#fff', borderRadius: 8, padding: '8px 16px', fontSize: 13, zIndex: 300 }}
        >
          {toast}
        </div>
      )}
    </div>
  )
}

const miniButton: React.CSSProperties = {
  fontSize: 12,
  border: '1px solid #e2e8f0',
  background: '#fff',
  color: '#475569',
  borderRadius: 6,
  padding: '3px 9px',
  cursor: 'pointer',
}

const menuItem: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  border: 'none',
  background: 'transparent',
  fontSize: 13,
  padding: '7px 10px',
  borderRadius: 5,
  cursor: 'pointer',
  color: '#334155',
}
