'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import type { ProviderView, ProvidersPayload } from '../lib/api'

const TASK_LABELS: Record<string, string> = {
  extract: '课件抽取',
  chunk: '切片',
  judge: '判题',
  quiz: '出题',
  check: '三检',
  variant: '变式',
  probe: '探查',
  method: '方法',
  solve: '解题',
}

/**
 * BYOK 设置：预置厂商填 key 即用，也可自建 OpenAI 兼容端点。
 *
 * 密钥只在提交时经过浏览器，之后再也拿不回来 —— 列表里只有末四位。
 * 这是接口层的约束（providers.ts 不回显明文），不是界面上的礼貌。
 */
export function ProviderSettings({ data, apiBaseUrl, token }: { data: ProvidersPayload; apiBaseUrl: string; token: string }) {
  const router = useRouter()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  /** 每个供应商各自的拉取结果，就地显示，不只依赖页面顶部那条全局消息 */
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [showAdd, setShowAdd] = useState(false)
  const [custom, setCustom] = useState({ name: '', baseUrl: '', modelId: '', apiKey: '' })

  const headers = { authorization: `Bearer ${token}` }

  async function call(key: string, path: string, init?: RequestInit) {
    setBusy(key)
    setMessage(null)
    try {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init?.headers ?? {}) },
      })
      if (!response.ok && response.status !== 204) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
        setMessage({ ok: false, text: body?.error?.message ?? `HTTP ${response.status}` })
        return null
      }
      router.refresh()
      return response
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) })
      return null
    } finally {
      setBusy(null)
    }
  }

  async function saveKey(provider: ProviderView) {
    const apiKey = (drafts[provider.id] ?? '').trim()
    if (!apiKey && provider.keyRequired) {
      setMessage({ ok: false, text: '请先填入密钥' })
      return
    }
    const ok = await call(`save-${provider.id}`, `/v1/providers/${provider.id}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: apiKey || 'local-no-key' }),
    })
    if (ok) {
      setDrafts((prev) => ({ ...prev, [provider.id]: '' }))
      const text = `✓ ${provider.name} 密钥已保存`
      setResults((prev) => ({ ...prev, [provider.id]: { ok: true, text } }))
      setMessage({ ok: true, text })
      // 保存后自动拉一次模型：少一步操作，也顺带验证这把密钥能不能用
      void refreshModels(provider)
    }
  }

  /** 用已保存的密钥拉取供应商真实模型列表 */
  async function refreshModels(provider: ProviderView) {
    setBusy(`refresh-${provider.id}`)
    setMessage(null)
    try {
      const response = await fetch(`${apiBaseUrl}/v1/providers/${provider.id}/models/refresh`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      })
      const body = (await response.json().catch(() => null)) as
        | { discovered?: number; added?: number; error?: { message?: string } }
        | null
      if (!response.ok) {
        const text = body?.error?.message ?? `拉取失败：HTTP ${response.status}`
        setResults((prev) => ({ ...prev, [provider.id]: { ok: false, text } }))
        setMessage({ ok: false, text })
        return
      }
      const text = `✓ 拉到 ${body?.discovered ?? 0} 个模型（新增 ${body?.added ?? 0} 个）`
      setResults((prev) => ({ ...prev, [provider.id]: { ok: true, text } }))
      setMessage({ ok: true, text })
      router.refresh()
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }

  /** 启用/停用某个模型：停用的不出现在"选择用哪个模型"里 */
  async function toggleModel(provider: ProviderView, modelId: string, enable: boolean) {
    setBusy(`model-${provider.id}-${modelId}`)
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/providers/${provider.id}/models/${encodeURIComponent(modelId)}`,
        {
          method: 'PATCH',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: enable }),
        },
      )
      if (!response.ok) {
        setMessage({ ok: false, text: `切换失败：HTTP ${response.status}` })
        return
      }
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  async function addCustom() {
    if (!custom.name.trim() || !custom.baseUrl.trim()) {
      setMessage({ ok: false, text: '名称与 Base URL 必填' })
      return
    }
    const created = await call('add-custom', '/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: custom.name.trim(),
        protocol: 'OPENAI',
        baseUrl: custom.baseUrl.trim(),
        models: custom.modelId.trim() ? [{ modelId: custom.modelId.trim() }] : [],
      }),
    })
    if (!created) return
    const provider = (await created.json()) as { id: string }
    if (custom.apiKey.trim()) {
      await call(`key-${provider.id}`, `/v1/providers/${provider.id}/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: custom.apiKey.trim() }),
      })
    }
    setCustom({ name: '', baseUrl: '', modelId: '', apiKey: '' })
    setShowAdd(false)
    setMessage({ ok: true, text: '已添加自定义供应商' })
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {!data.encryptionReady && (
        <p data-testid="encryption-not-ready" style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: 12, fontSize: 13 }}>
          主密钥未就绪，暂时无法保存密钥。桌面版会在首次启动时自动生成，请重启客户端后再试。
        </p>
      )}

      {message && (
        <p data-testid="provider-message" style={{ fontSize: 13, color: message.ok ? '#059669' : '#dc2626' }}>
          {message.text}
        </p>
      )}

      <div>
        <button
          type="button"
          data-testid="toggle-add-custom"
          onClick={() => setShowAdd((v) => !v)}
          style={{ padding: '6px 12px', borderRadius: 6, border: '1px dashed #9ca3af', background: '#fff', cursor: 'pointer', fontSize: 13 }}
        >
          {showAdd ? '收起' : '＋ 添加自定义 OpenAI 兼容端点'}
        </button>
        {showAdd && (
          <div data-testid="add-custom-form" style={{ marginTop: 10, border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, display: 'grid', gap: 8 }}>
            <input placeholder="名称，例如 校园网关" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} style={inputStyle} />
            <input placeholder="Base URL，例如 https://gw.example.com/v1" value={custom.baseUrl} onChange={(e) => setCustom({ ...custom, baseUrl: e.target.value })} style={inputStyle} />
            <input placeholder="模型名，例如 gpt-4o-mini（可稍后再补）" value={custom.modelId} onChange={(e) => setCustom({ ...custom, modelId: e.target.value })} style={inputStyle} />
            <input type="password" placeholder="密钥（本地端点可留空）" value={custom.apiKey} onChange={(e) => setCustom({ ...custom, apiKey: e.target.value })} style={inputStyle} />
            <button type="button" data-testid="submit-custom" disabled={busy === 'add-custom'} onClick={addCustom} style={primaryButton}>
              {busy === 'add-custom' ? '添加中…' : '添加'}
            </button>
          </div>
        )}
      </div>

      {data.providers.map((provider) => (
        <section key={provider.id} data-testid={`provider-${provider.slug}`} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600 }}>{provider.name}</h2>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>{provider.protocol}</span>
            {provider.isCustom && (
              <span style={{ fontSize: 11, color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 999, padding: '0 6px' }}>自定义</span>
            )}
            {provider.docsUrl && (
              <a href={provider.docsUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#2563eb', marginLeft: 'auto' }}>
                获取 key
              </a>
            )}
            {provider.isCustom && (
              <button
                type="button"
                data-testid={`delete-provider-${provider.slug}`}
                onClick={() => call(`del-${provider.id}`, `/v1/providers/${provider.id}`, { method: 'DELETE' })}
                style={{ fontSize: 12, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', marginLeft: 'auto' }}
              >
                删除供应商
              </button>
            )}
          </div>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: '4px 0 10px' }}>{provider.baseUrl}</p>

          {/* 已保存的密钥：常驻显示，不闪一下就消失 ——
              用户需要随时能确认"我到底存了没有、存的是哪一把" */}
          {provider.credentials.length > 0 ? (
            <ul data-testid={`creds-${provider.slug}`} style={{ listStyle: 'none', padding: 0, margin: '0 0 10px', display: 'grid', gap: 6 }}>
              {provider.credentials.map((credential) => (
                <li key={credential.id} style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#059669', fontSize: 12 }}>✓ 密钥已保存</span>
                  <code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: 4 }}>sk-…{credential.last4}</code>
                  <span style={{ color: '#9ca3af' }}>{credential.label}</span>
                  <button
                    type="button"
                    onClick={() => call(`delc-${credential.id}`, `/v1/credentials/${credential.id}`, { method: 'DELETE' })}
                    style={{ marginLeft: 'auto', fontSize: 12, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 10px' }}>尚未保存密钥</div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="password"
              data-testid={`key-input-${provider.slug}`}
              placeholder={provider.keyRequired ? 'sk-...' : '本地端点可不填'}
              value={drafts[provider.id] ?? ''}
              onChange={(event) => setDrafts((prev) => ({ ...prev, [provider.id]: event.target.value }))}
              style={inputStyle}
            />
            <button
              type="button"
              data-testid={`save-${provider.slug}`}
              disabled={busy === `save-${provider.id}` || !data.encryptionReady}
              onClick={() => saveKey(provider)}
              style={primaryButton}
            >
              {busy === `save-${provider.id}` ? '保存中…' : '保存'}
            </button>
          </div>

          {/* 模型列表：用已保存的密钥去问供应商「你有哪些模型」 */}
          <div style={{ marginTop: 12, borderTop: '1px solid #f1f5f9', paddingTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: provider.models.length > 0 ? 8 : 0 }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                模型 {provider.models.length > 0 ? `(${provider.models.length})` : ''}
              </span>
              {/* 拉取结果就地反馈：写在这个供应商的卡片里，而不是只闪在页面顶部 */}
              {results[provider.id] && (
                <span
                  data-testid={`refresh-result-${provider.slug}`}
                  style={{ fontSize: 11, color: results[provider.id]!.ok ? '#059669' : '#dc2626' }}
                >
                  {results[provider.id]!.text}
                </span>
              )}
              <button
                type="button"
                data-testid={`refresh-models-${provider.slug}`}
                disabled={busy === `refresh-${provider.id}` || provider.credentials.length === 0}
                title={provider.credentials.length === 0 ? '请先保存密钥' : '用你的密钥拉取这个供应商的模型列表'}
                onClick={() => refreshModels(provider)}
                style={{ ...secondaryButton, marginLeft: 'auto' }}
              >
                {busy === `refresh-${provider.id}` ? '拉取中…' : '拉取模型列表'}
              </button>
            </div>

            {provider.credentials.length === 0 && (
              <div data-testid={`no-key-hint-${provider.slug}`} style={{ fontSize: 11, color: '#d97706', marginTop: 4 }}>
                还没有密钥：先在上面填入并点「保存」，然后才能拉取模型列表。
              </div>
            )}

            {/* 模型标签只做展示，**点标签本身什么都不会发生**。
                启用/停用走旁边那个明确的按钮：标签可点 + 点一下就消失，是这个页面
                之前最坏的体验（用户点了两下，模型全没了，还以为密钥没保存）。

                停用的模型也必须显示出来（灰色 + 「启用」按钮）——
                看不见就等于删掉了，而且任务下拉会莫名其妙变空，没人能想到原因。 */}
            {provider.models.length > 0 && (
              <div data-testid={`models-${provider.slug}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                {provider.models.map((model) => {
                  const enabled = model.enabled !== false
                  return (
                    <span
                      key={model.id}
                      data-testid={`model-${provider.slug}-${model.modelId}`}
                      data-enabled={String(enabled)}
                      title={`${model.modelId}${enabled ? '' : '（已停用：停用的模型不出现在任务下拉里）'}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        fontSize: 11,
                        padding: '2px 3px 2px 8px',
                        borderRadius: 999,
                        border: `1px solid ${enabled ? '#bfdbfe' : '#d1d5db'}`,
                        background: enabled ? '#eff6ff' : '#f3f4f6',
                        color: enabled ? '#1d4ed8' : '#9ca3af',
                      }}
                    >
                      {model.displayName || model.modelId}
                      <button
                        type="button"
                        data-testid={`toggle-model-${provider.slug}-${model.modelId}`}
                        disabled={busy !== null}
                        onClick={() => void toggleModel(provider, model.modelId, !enabled)}
                        style={{
                          fontSize: 10,
                          lineHeight: '14px',
                          border: 'none',
                          borderRadius: 999,
                          padding: '0 6px',
                          cursor: busy !== null ? 'wait' : 'pointer',
                          background: enabled ? '#dbeafe' : '#2563eb',
                          color: enabled ? '#1d4ed8' : '#fff',
                        }}
                      >
                        {enabled ? '停用' : '启用'}
                      </button>
                    </span>
                  )
                })}
                {provider.models.some((model) => model.enabled === false) && (
                  <button
                    type="button"
                    data-testid={`enable-all-${provider.slug}`}
                    disabled={busy !== null}
                    onClick={() => {
                      const disabled = provider.models.filter((model) => model.enabled === false)
                      void (async () => {
                        for (const model of disabled) await toggleModel(provider, model.modelId, true)
                        setMessage({ ok: true, text: `已启用 ${provider.name} 的 ${disabled.length} 个模型` })
                      })()
                    }}
                    style={secondaryButton}
                  >
                    全部启用
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      ))}

      {/* 按任务类型选模型：这才是"学生决定用哪个模型"的地方 */}
      <TaskPreferences
        providers={data.providers}
        preferences={data.preferences}
        requiredCapabilities={data.requiredCapabilities}
        apiBaseUrl={apiBaseUrl}
        token={token}
        onChanged={() => router.refresh()}
        onError={(text) => setMessage({ ok: false, text })}
        onDone={(text) => setMessage({ ok: true, text })}
      />
    </div>
  )
}

/**
 * 按任务类型指定用哪个模型。
 *
 * 这是"学生自己决定用什么模型"的落点：同一个密钥下可能有好几个模型，
 * 抽取用便宜的、推理用贵的，完全由学生决定。
 * 不配则走默认路由（routing.ts 里那张表）。
 */
function TaskPreferences({
  providers,
  preferences,
  requiredCapabilities,
  apiBaseUrl,
  token,
  onChanged,
  onError,
  onDone,
}: {
  providers: ProviderView[]
  preferences: Array<{ taskType: string; credentialId: string; modelId: string }>
  requiredCapabilities: Record<string, string | null>
  apiBaseUrl: string
  token: string
  onChanged: () => void
  onError: (text: string) => void
  onDone: (text: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)

  /**
   * 下拉里列出**所有**模型，包括停用的。
   *
   * 之前的实现只列启用的，后果很严重：如果某个供应商的模型全被停用，
   * `options` 就是空的，而下面把 `<select>` 设成 `disabled={options.length === 0}` ——
   * 于是下拉整个点不动。用户看到的是"我点了没反应"，而不是"模型被停用了"。
   * 这个状态是我自己在别处造成的（旧版把点模型名做成了停用开关），
   * 结果却表现为一个完全无解释的死控件。
   *
   * 停用的模型标成「已停用」，选了会提示去启用 —— **可见性优先于可选项过滤**。
   */
  const options = providers.flatMap((provider) => {
    if (provider.credentials.length === 0) return []
    return (provider.models ?? []).map((model) => {
      const enabled = model.enabled !== false
      return {
        value: `${provider.credentials[0]!.id}::${model.modelId}`,
        label: `${provider.name} · ${model.displayName || model.modelId}${enabled ? '' : '（已停用）'}`,
        capability: (model.capabilities ?? {}) as Record<string, unknown>,
        modelId: model.modelId,
        warn: enabled ? null : `「${model.displayName || model.modelId}」现在是停用状态，运行会失败。到上面的模型列表点「启用」即可。`,
        providerId: provider.id,
      }
    })
  })

  /** 存了偏好但模型/凭据已经不存在（删了密钥、拉取的模型被移除）时，仍要显示出来 */
  const knownValues = new Set(options.map((option) => option.value))
  for (const pref of preferences) {
    const value = `${pref.credentialId}::${pref.modelId}`
    if (knownValues.has(value)) continue
    knownValues.add(value)
    options.push({
      value,
      label: `${pref.modelId}（不可用：密钥已删或模型已移除）`,
      capability: {},
      modelId: pref.modelId,
      warn: '这个模型已经不可用（密钥删除或模型被移除），建议重新选一个',
      providerId: '',
    })
  }

  const disabledCount = providers.reduce(
    (sum, provider) => sum + (provider.models ?? []).filter((model) => model.enabled === false).length,
    0,
  )

  const currentValue = (taskType: string) => {
    const pref = preferences.find((entry) => entry.taskType === taskType)
    return pref ? `${pref.credentialId}::${pref.modelId}` : ''
  }

  async function choose(taskType: string, value: string) {
    setBusy(taskType)
    try {
      if (!value) {
        const response = await fetch(`${apiBaseUrl}/v1/preferences/${taskType}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        })
        if (!response.ok) {
          onError(`清除失败：HTTP ${response.status}`)
          return
        }
        onDone('已恢复默认路由')
        onChanged()
        return
      }

      const [credentialId, modelId] = value.split('::')
      const response = await fetch(`${apiBaseUrl}/v1/preferences/${taskType}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ credentialId, modelId }),
      })
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
      if (!response.ok) {
        onError(body?.error?.message ?? `保存失败：HTTP ${response.status}`)
        return
      }
      onDone(`${TASK_LABELS[taskType] ?? taskType} 已改用 ${modelId}`)
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  return (
    <section data-testid="task-preferences" style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>各任务用哪个模型</h2>
      <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
        不选就走默认路由。抽取这类机械任务建议用便宜的模型，推理任务用强一点的。
      </p>

      {options.length === 0 && (
        <p data-testid="pref-empty-hint" style={{ fontSize: 12, color: '#d97706' }}>
          这里还选不了，因为上面还没有「已保存密钥 + 已启用模型」的供应商。
          先在上方填入密钥点保存（会自动拉取模型），再回来这里选。
          {disabledCount > 0 && `（有 ${disabledCount} 个模型处于停用状态，去上面点「启用」）`}
        </p>
      )}

      {options.length > 0 && disabledCount > 0 && (
        <p data-testid="pref-disabled-hint" style={{ fontSize: 12, color: '#b45309', marginBottom: 8 }}>
          有 {disabledCount} 个模型是停用状态，不会出现在下面的下拉里；要用它们请到上面的模型列表点「启用」。
        </p>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {Object.keys(TASK_LABELS).map((taskType) => {
          const need = requiredCapabilities[taskType]
          const value = currentValue(taskType)
          const selected = options.find((option) => option.value === value)
          const missing = need && selected && Object.keys(selected.capability).length > 0 && selected.capability[need] !== true

          return (
            <div key={taskType} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 84, fontSize: 13, color: '#374151' }}>{TASK_LABELS[taskType]}</span>
              <select
                data-testid={`pref-${taskType}`}
                value={value}
                disabled={busy === taskType || options.length === 0}
                onChange={(event) => void choose(taskType, event.target.value)}
                style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12, background: '#fff' }}
              >
                <option value="">默认路由</option>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {missing && (
                <span data-testid={`pref-warning-${taskType}`} style={{ fontSize: 11, color: '#d97706' }}>
                  缺 {need}
                </span>
              )}
              {/* 把"当前用的是哪个模型"写成文字：下拉框本身太不显眼，
                  用户选了却以为自己没选上（实际反馈） */}
              <span
                data-testid={`pref-current-${taskType}`}
                style={{ fontSize: 11, color: value ? '#1d4ed8' : '#94a3b8', minWidth: 96, textAlign: 'right' }}
              >
                {value ? (selected?.label ?? '未知模型') : '默认路由'}
              </span>
              {selected?.warn && (
                <span data-testid={`pref-orphan-${taskType}`} style={{ fontSize: 11, color: '#dc2626', maxWidth: 190 }}>
                  ⚠ {selected.warn}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  fontSize: 13,
  minWidth: 0,
}

const secondaryButton: React.CSSProperties = {
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: '#fff',
  color: '#374151',
  cursor: 'pointer',
  fontSize: 12,
  whiteSpace: 'nowrap',
}

const primaryButton: React.CSSProperties = {
  padding: '6px 14px',
  borderRadius: 6,
  border: 'none',
  background: '#2563eb',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 13,
  whiteSpace: 'nowrap',
}
