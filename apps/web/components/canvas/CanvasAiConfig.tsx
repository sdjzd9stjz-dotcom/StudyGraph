'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * 画布自己的 AI 配置（用户 2026-11-23 要求：AI 配置每块画布独立）。
 *
 * 优先级在服务端实现：画布配置 → 用户全局配置 → 内置默认路由。
 * 这里只负责让人看清"这块画布现在用的是什么"，并能改。
 *
 * 为什么每一行都显示"当前生效"：只显示下拉选了什么，用户在全局改了之后
 * 会以为这块画布也跟着变（或者相反）。真正的答案必须来自服务端的合并结果。
 */
const TASKS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'assistant', label: '底部对话', hint: '读画布内容、改画布结构' },
  { key: 'extract', label: '概念抽取', hint: '从课件里抽知识点' },
  { key: 'quiz', label: '出题', hint: '生成练习题' },
  { key: 'method', label: '方法 / 深入理解 / 讲义', hint: '推理型任务' },
]

interface ModelOption {
  credentialId: string
  provider: string
  modelId: string
}

export function CanvasAiConfig({ canvasId, apiBaseUrl, token }: { canvasId: string; apiBaseUrl: string; token: string }) {
  const [options, setOptions] = useState<ModelOption[]>([])
  const [canvasPrefs, setCanvasPrefs] = useState<Record<string, { modelId: string; credentialId: string }>>({})
  const [globalPrefs, setGlobalPrefs] = useState<Record<string, { modelId: string }>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }

  const load = useCallback(async () => {
    const [providersResponse, prefsResponse] = await Promise.all([
      fetch(`${apiBaseUrl}/v1/providers`, { headers: { authorization: `Bearer ${token}` } }),
      fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/model-prefs`, { headers: { authorization: `Bearer ${token}` } }),
    ])

    if (providersResponse.ok) {
      const payload = (await providersResponse.json()) as {
        providers: Array<{ name: string; credentials: Array<{ id: string }>; models: Array<{ modelId: string; enabled: boolean }> }>
      }
      const list: ModelOption[] = []
      for (const provider of payload.providers) {
        for (const credential of provider.credentials) {
          for (const model of provider.models.filter((item) => item.enabled)) {
            list.push({ credentialId: credential.id, provider: provider.name, modelId: model.modelId })
          }
        }
      }
      setOptions(list)
    }

    if (prefsResponse.ok) {
      const payload = (await prefsResponse.json()) as {
        canvasPrefs: Array<{ taskType: string; credentialId: string; modelId: string }>
        globalPrefs: Array<{ taskType: string; modelId: string }>
      }
      setCanvasPrefs(Object.fromEntries(payload.canvasPrefs.map((pref) => [pref.taskType, pref])))
      setGlobalPrefs(Object.fromEntries(payload.globalPrefs.map((pref) => [pref.taskType, pref])))
    }
  }, [apiBaseUrl, canvasId, token])

  useEffect(() => {
    void load()
  }, [load])

  const setPref = useCallback(
    async (taskType: string, value: string) => {
      setBusy(taskType)
      try {
        if (value === '') {
          // 清空 = 回落到全局配置（不是"不配置"）
          const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/model-prefs/${taskType}`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${token}` },
          })
          if (!response.ok && response.status !== 204) {
            setToast(`清除失败：${response.status}`)
            return
          }
          setToast('已改为跟随全局配置')
        } else {
          const [credentialId, modelId] = value.split('::')
          const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/model-prefs/${taskType}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ credentialId, modelId }),
          })
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
            setToast(body?.error?.message ?? `保存失败：${response.status}`)
            return
          }
          setToast('已保存到这块画布')
        }
        await load()
      } finally {
        setBusy(null)
        window.setTimeout(() => setToast(null), 2400)
      }
    },
    [apiBaseUrl, canvasId, headers, load, token],
  )

  return (
    <section data-testid="canvas-ai-config" style={{ borderTop: '1px solid #e2e8f0', background: '#fff' }}>
      <details>
        <summary style={{ cursor: 'pointer', padding: '8px 16px', fontSize: 13, color: '#334155' }}>
          AI 配置（这块画布独立设置）
        </summary>
        <div style={{ padding: '0 16px 16px', display: 'grid', gap: 10 }}>
          <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
            只影响这块画布；留空则跟随「模型供应商」里的全局设置。
          </p>
          {TASKS.map((task) => {
            const canvasPref = canvasPrefs[task.key]
            const value = canvasPref ? `${canvasPref.credentialId}::${canvasPref.modelId}` : ''
            const effective = canvasPref?.modelId ?? globalPrefs[task.key]?.modelId ?? '内置默认'
            return (
              <div key={task.key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                <span style={{ width: 170, color: '#334155' }}>{task.label}</span>
                <select
                  data-testid={`canvas-model-${task.key}`}
                  disabled={busy === task.key}
                  value={value}
                  onChange={(event) => void setPref(task.key, event.target.value)}
                  style={{ flex: 1, maxWidth: 320, border: '1px solid #cbd5e1', borderRadius: 7, padding: '5px 8px', fontSize: 12 }}
                >
                  <option value="">跟随全局</option>
                  {options.map((option) => (
                    <option key={`${option.credentialId}::${option.modelId}`} value={`${option.credentialId}::${option.modelId}`}>
                      {option.provider} · {option.modelId}
                    </option>
                  ))}
                </select>
                <span style={{ color: '#94a3b8' }}>当前：{effective}</span>
              </div>
            )
          })}
          {toast && <span data-testid="canvas-ai-toast" style={{ fontSize: 12, color: '#0f766e' }}>{toast}</span>}
        </div>
      </details>
    </section>
  )
}
