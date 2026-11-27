'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { reasoningLevels } from '../../../../packages/contracts/src/reasoning'
import { TASK_LABELS } from '../../../../packages/contracts/src/task-capabilities'

interface Model { modelId: string; enabled: boolean; capabilities: unknown }
interface Provider { slug: string; name: string; protocol: string; credentials: { id: string; label: string }[]; models: Model[] }
interface Preference { taskType: string; credentialId: string; modelId: string; credential?: { isActive: boolean; provider: { slug: string; protocol: string } } }
interface Route { provider: string; model: string }
interface Effort extends Route { scope: string; effort: string }
interface Settings {
  canvasPrefs: Preference[]; globalPrefs: Preference[]; defaults: Record<string, Route>; efforts: Effort[]; providers: Provider[]
}
interface Controls {
  settings?: Settings; error: string; reload: () => void; flush: () => Promise<void>
  setModel: (task: string, pref?: Preference) => void
  setEffort: (task: string, scope: string, route: Route, effort: string | null) => void
}
const Context = createContext<Controls | null>(null)
export function useModelControls() {
  const controls = useContext(Context)
  if (!controls) throw Error('画布模型设置尚未挂载')
  return controls
}

export function CanvasModelProvider({ apiBaseUrl, canvasId, token, children }: {
  apiBaseUrl: string; canvasId: string; token: string; children: ReactNode
}) {
  const [settings, setSettings] = useState<Settings>()
  const [error, setError] = useState('')
  const pending = useRef(Promise.resolve())
  const revision = useRef(0)
  const endpoint = `${apiBaseUrl}/v1/canvases/${canvasId}`
  const request = useCallback(async (url: string, method = 'GET', body?: unknown) => {
    const response = await fetch(url, { method, cache: 'no-store', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    if (!response.ok) throw Error((await response.json().catch(() => null))?.error?.message ?? `模型设置读写失败（${response.status}）`)
    return response
  }, [token])
  const load = useCallback(async () => {
    const stamp = ++revision.current
    await pending.current.catch(() => {})
    try {
      const [catalog, prefs] = await Promise.all([request(`${apiBaseUrl}/v1/providers`).then(r => r.json()), request(`${endpoint}/model-prefs`).then(r => r.json())])
      if (stamp === revision.current) { setSettings({ ...prefs, providers: catalog.providers }); pending.current = Promise.resolve(); setError('') }
    } catch (e) { if (stamp === revision.current) setError(String(e)) }
  }, [apiBaseUrl, endpoint, request])
  useEffect(() => {
    void load(); window.addEventListener('focus', load)
    return () => { revision.current++; window.removeEventListener('focus', load) }
  }, [load])
  const flush = useCallback(() => pending.current, [])
  function save(update: (s: Settings) => Settings, write: () => Promise<Response>) {
    if (error) { void load(); return }
    revision.current++
    setSettings(s => s && update(s)); setError('')
    const operation = pending.current.then(write).then(() => {})
    pending.current = operation
    void operation.catch(e => { setError(`保存失败。${String(e)}。请重新读取后再试。`) })
  }
  const controls: Controls = { settings, error, flush, reload: () => {
    // 重新读取意味着放弃失败的本地选择；下一次运行使用已存的设置。
    pending.current = pending.current.catch(() => {}); void load()
  }, setModel(task, pref) {
    save(s => ({ ...s, canvasPrefs: [...s.canvasPrefs.filter(p => p.taskType !== task), ...(pref ? [pref] : [])] }),
      () => request(`${endpoint}/model-prefs/${task}`, pref ? 'PUT' : 'DELETE', pref))
  }, setEffort(task, scope, route, effort) {
    save(s => ({ ...s, efforts: [...s.efforts.filter(p => p.scope !== scope), ...(effort ? [{ ...route, scope, effort }] : [])] }),
      () => request(`${endpoint}/reasoning/${encodeURIComponent(scope)}`, 'PUT', { task, ...route, effort }))
  } }
  return <Context.Provider value={controls}>{children}</Context.Provider>
}

const fieldStyle = { fontSize: 12, color: '#334155', display: 'grid', gap: 4 } as const
export function ModelControls({ task, scope, label }: { task: string; scope: string; label: string }) {
  const [expanded, setExpanded] = useState(false)
  const { settings, error, reload, setModel, setEffort } = useModelControls()
  const providers = settings?.providers ?? []
  const active = (pref: Preference) => pref.credential?.isActive ?? providers.some(p => p.credentials.some(c => c.id === pref.credentialId))
  const own = settings?.canvasPrefs.find(p => p.taskType === task && active(p))
  const pref = own ?? settings?.globalPrefs.find(p => p.taskType === task && active(p))
  const fallback = settings?.defaults[task]
  const provider = pref ? providers.find(p => p.slug === pref.credential?.provider.slug || p.credentials.some(c => c.id === pref.credentialId)) : providers.find(p => p.slug === fallback?.provider)
  const model = pref?.modelId ?? fallback?.model
  const slug = provider?.slug ?? pref?.credential?.provider.slug ?? fallback?.provider
  const levels = model ? reasoningLevels(model, provider?.protocol ?? pref?.credential?.provider.protocol ?? (slug === 'anthropic' ? 'ANTHROPIC' : 'OPENAI'), provider?.models.find(m => m.modelId === model)?.capabilities) : []
  const selected = settings?.efforts.find(p => p.scope === scope && p.model === model && p.provider === slug)?.effort
  const index = selected ? levels.indexOf(selected) + 1 : 0
  const text = selected && !index ? `档位已失效（${selected}）` : selected ?? '模型默认'
  const key = (credentialId: string, modelId: string) => JSON.stringify([credentialId, modelId])
  return <details onToggle={e => setExpanded(e.currentTarget.open)} data-model-scope={scope} className="nodrag nopan nowheel" style={{ margin: '3px 8px', fontSize: 12, minWidth: 0, color: '#475569' }}>
    <summary style={{ cursor: 'pointer', overflowWrap: 'anywhere', padding: '4px 0' }}>{label} · {model ?? '读取中'}{model && ` · ${text}`}{error && ' · 设置异常'}</summary>
    {expanded && <div style={{ display: 'grid', gap: 8, padding: '5px 2px 8px', maxWidth: 440 }}>
      {error && <div role="alert">{error} <button type="button" onClick={reload}>重新读取</button></div>}
      <label style={fieldStyle}>画布模型 · {TASK_LABELS[task]}
        <select aria-label={`${label}选择`} disabled={!settings || Boolean(error)} style={{ minWidth: 0, width: '100%' }} value={own ? key(own.credentialId, own.modelId) : ''} onChange={e => {
          const pair = e.target.value ? JSON.parse(e.target.value) as [string, string] : null
          setModel(task, pair ? { taskType: task, credentialId: pair[0], modelId: pair[1] } : undefined)
        }}>
          <option value="">跟随全局设置</option>
          {own && !providers.some(p => p.credentials.some(c => c.id === own.credentialId) && p.models.some(m => m.modelId === own.modelId)) && <option value={key(own.credentialId, own.modelId)}>{own.modelId}</option>}
          {providers.flatMap(p => p.credentials.flatMap(c => p.models.filter(m => m.enabled || (own?.modelId === m.modelId && c.id === own.credentialId)).map(m =>
            <option key={key(c.id, m.modelId)} value={key(c.id, m.modelId)} disabled={!m.enabled}>{p.name} · {m.modelId}{p.credentials.length > 1 && `（${c.label}）`}</option>)))}
        </select>
      </label>
      {levels.length > 0 && model && slug ? <label style={fieldStyle}>推理强度 · {text}
        <input type="range" disabled={Boolean(error)} min={0} max={levels.length} step={1} value={index} aria-label={`${label}推理强度`} aria-valuetext={text} style={{ width: '100%', margin: 0, accentColor: '#2563eb' }}
          onChange={e => setEffort(task, scope, { model, provider: slug }, levels[Number(e.target.value) - 1] ?? null)} />
        <span aria-hidden="true" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, gap: 2, color: '#64748b' }}>{['默认', ...levels].map(l => <span key={l}>{l}</span>)}</span>
      </label> : model && <span>推理强度由模型决定，当前型号未提供可调档位。</span>}
      {selected && !index && model && slug && <button type="button" onClick={() => setEffort(task, scope, { model, provider: slug }, null)}>恢复模型默认</button>}
    </div>}
  </details>
}
