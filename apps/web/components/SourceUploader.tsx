'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

/**
 * 上传课件 → 落成一个 SOURCE 节点。
 *
 * apiBaseUrl 与 token 都由服务端传进来：桌面版每次启动才分配端口，
 * 构建期写死的 NEXT_PUBLIC_* 一定是错的（见交接文档「共享的六个坑」）。
 */
export function SourceUploader({ canvasId, apiBaseUrl, token }: { canvasId: string; apiBaseUrl: string; token: string }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <input
        ref={inputRef}
        type="file"
        accept=".pptx,.pdf"
        data-testid="source-file-input"
        style={{ display: 'none' }}
        onChange={async (event) => {
          const file = event.target.files?.[0]
          if (!file) return
          setBusy(true)
          setMessage(null)
          try {
            const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/sources`, {
              method: 'POST',
              headers: {
                'content-type': 'application/octet-stream',
                authorization: `Bearer ${token}`,
                'x-filename': encodeURIComponent(file.name),
              },
              body: file,
            })
            if (!response.ok) {
              const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
              setMessage(`上传失败：${body?.error?.message ?? response.status}`)
              return
            }
            setMessage(`已上传：${file.name}`)
            router.refresh()
          } catch (error) {
            setMessage(`上传失败：${error instanceof Error ? error.message : String(error)}`)
          } finally {
            setBusy(false)
            if (inputRef.current) inputRef.current.value = ''
          }
        }}
      />
      <button
        type="button"
        disabled={busy}
        data-testid="upload-source"
        onClick={() => inputRef.current?.click()}
        style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}
      >
        {busy ? '上传中…' : '上传课件'}
      </button>
      {message && (
        <span data-testid="upload-message" style={{ fontSize: 12, color: message.startsWith('上传失败') ? '#dc2626' : '#059669' }}>
          {message}
        </span>
      )}
    </span>
  )
}
