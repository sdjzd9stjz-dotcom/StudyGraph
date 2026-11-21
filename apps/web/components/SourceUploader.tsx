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
  /**
   * 「这是扫描件」。
   *
   * 默认不勾：扫描件要 OCR，而 OCR 是**把像素猜成字**。
   * 猜出来的文字会被当成原文引用，所以必须由用户明确要求，
   * 不能因为"反正能抽点东西"就默默打开。
   */
  const [ocr, setOcr] = useState(false)

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <input
        ref={inputRef}
        type="file"
        accept=".pptx,.ppt,.pdf"
        data-testid="source-file-input"
        style={{ display: 'none' }}
        onChange={async (event) => {
          const file = event.target.files?.[0]
          if (!file) return

          /**
           * 先查大小再发请求。
           *
           * 超过上限时服务端会直接掐掉连接，浏览器只报 `Failed to fetch` ——
           * 学生看到的是"网络坏了"，实际只是文件太大。这里提前说清楚。
           */
          const MAX_BYTES = 400 * 1024 * 1024
          if (file.size > MAX_BYTES) {
            setMessage(`上传失败：文件 ${(file.size / 1048576).toFixed(0)}MB，超过 400MB 上限。请拆分或用导出为 PDF 的版本。`)
            if (inputRef.current) inputRef.current.value = ''
            return
          }

          setBusy(true)
          setMessage(null)
          try {
            const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/sources`, {
              method: 'POST',
              headers: {
                'content-type': 'application/octet-stream',
                authorization: `Bearer ${token}`,
                'x-filename': encodeURIComponent(file.name),
                ...(ocr ? { 'x-ocr': '1' } : {}),
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
            /**
             * `Failed to fetch` 几乎没有信息量：可能是连接被断、服务没起、或跨域被拒。
             * 附上能自己排查的线索，而不是把浏览器的原话原样丢给学生。
             */
            const raw = error instanceof Error ? error.message : String(error)
            setMessage(
              `上传失败：${raw}` +
                (raw.includes('Failed to fetch')
                  ? '（请求没到达服务。检查：文件是否过大、软件是否已完全启动、换个网络环境再试）'
                  : ''),
            )
          } finally {
            setBusy(false)
            if (inputRef.current) inputRef.current.value = ''
          }
        }}
      />
      <label
        title="扫描件没有文字层。勾上会用本机 OCR 识别，慢一些，且识别结果不是原文"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6b7280', cursor: 'pointer' }}
      >
        <input
          type="checkbox"
          data-testid="upload-ocr"
          checked={ocr}
          onChange={(event) => setOcr(event.target.checked)}
        />
        扫描件（OCR）
      </label>
      <button
        type="button"
        disabled={busy}
        data-testid="upload-source"
        onClick={() => inputRef.current?.click()}
        style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}
      >
        {busy ? (ocr ? '识别中…' : '上传中…') : '上传课件'}
      </button>
      {message && (
        <span data-testid="upload-message" style={{ fontSize: 12, color: message.startsWith('上传失败') ? '#dc2626' : '#059669' }}>
          {message}
        </span>
      )}
    </span>
  )
}
