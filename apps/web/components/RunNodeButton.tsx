'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

/**
 * 执行单个节点（M2：同步执行，未接队列）。
 *
 * 硬约束「执行必须显式触发」在界面上就体现为这个按钮：除了用户点它，
 * 没有任何路径会自动跑节点、自动消耗 token。
 */
export function RunNodeButton({ nodeId, apiBaseUrl, token }: { nodeId: string; apiBaseUrl: string; token: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <>
      <button
        type="button"
        disabled={busy}
        data-testid={`run-node-${nodeId}`}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            const response = await fetch(`${apiBaseUrl}/v1/nodes/${nodeId}/run`, {
              method: 'POST',
              headers: { authorization: `Bearer ${token}` },
            })
            const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
            if (!response.ok) {
              setError(body?.error?.message ?? `HTTP ${response.status}`)
              return
            }
            router.refresh()
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
          } finally {
            setBusy(false)
          }
        }}
        style={{
          marginLeft: 6,
          padding: '0 8px',
          fontSize: 11,
          borderRadius: 999,
          border: '1px solid #d1d5db',
          background: busy ? '#f3f4f6' : '#fff',
          cursor: 'pointer',
        }}
      >
        {busy ? '执行中…' : '执行'}
      </button>
      {error && (
        <span data-testid={`run-error-${nodeId}`} style={{ marginLeft: 6, fontSize: 11, color: '#dc2626' }}>
          {error}
        </span>
      )}
    </>
  )
}
