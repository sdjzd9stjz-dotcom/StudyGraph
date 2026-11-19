'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { API_BASE_URL } from '../lib/api'

// 浏览器端用同一个 dev token；真实产品里这里应该是登录态
const TOKEN = process.env.NEXT_PUBLIC_DEV_PAT ?? ''

export function CreateCanvasButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const response = await fetch(`${API_BASE_URL}/v1/canvases`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
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
