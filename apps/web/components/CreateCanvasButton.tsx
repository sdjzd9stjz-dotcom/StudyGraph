'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

// token 与 apiBaseUrl 都必须由服务端作为 prop 传进来。
//
// 两个都是同一个坑的两面（交接文档 §4 第 5 条）：
//   · token 不能读 NEXT_PUBLIC_DEV_PAT —— 构建期就内联，运行时给环境变量无效
//   · apiBaseUrl 不能用模块常量 API_BASE_URL —— 在浏览器 bundle 里它会求值成
//     http://127.0.0.1:3001（构建期的兜底值），而桌面版每次启动的 API 都在随机端口上。
//     症状就是「点新建画布没反应」：请求打到了 3001，那里什么都没有。
export function CreateCanvasButton({ token, apiBaseUrl }: { token: string; apiBaseUrl: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const response = await fetch(`${apiBaseUrl}/v1/canvases`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ title: `未命名画布 ${new Date().toLocaleTimeString('zh-CN')}` }),
          })
          if (response.ok) {
            const canvas = (await response.json()) as { id: string }
            router.push(`/c/${canvas.id}`)
          } else {
            const body = (await response.json()) as { error?: { message?: string } }
            alert(body.error?.message ?? '创建失败')
          }
        } finally {
          setBusy(false)
        }
      }}
      style={{
        padding: '8px 14px',
        borderRadius: 8,
        border: '1px solid #2563eb',
        background: busy ? '#93c5fd' : '#2563eb',
        color: '#fff',
        cursor: busy ? 'wait' : 'pointer',
      }}
    >
      新建画布
    </button>
  )
}
