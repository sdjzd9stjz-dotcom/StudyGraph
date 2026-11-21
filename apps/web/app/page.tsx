import Link from 'next/link'

import { API_BASE_URL, fetchCanvasList, fetchReviewStats, serverToken } from '../lib/api'
import { CreateCanvasButton } from '../components/CreateCanvasButton'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const [canvases, stats] = await Promise.all([fetchCanvasList(), fetchReviewStats()])

  return (
    <main style={{ padding: 32, maxWidth: 900, margin: '0 auto' }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 4 }}>StudyGraph</h1>
      <p style={{ color: '#6b7280', marginBottom: 24 }}>节点式 AI 学习工作流 · M1 画布底座</p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20 }}>
        <CreateCanvasButton token={serverToken()} apiBaseUrl={API_BASE_URL} />
        <span style={{ color: '#9ca3af', fontSize: 13 }}>共 {canvases.length} 张画布</span>
        <Link
          href="/review"
          data-testid="review-entry"
          style={{ color: stats.dueCount + stats.newCount > 0 ? '#2563eb' : '#9ca3af', fontSize: 13, marginLeft: 'auto' }}
        >
          今日到期 {stats.dueCount + stats.newCount}
        </Link>
        <Link href="/problems" style={{ color: '#2563eb', fontSize: 13 }}>
          题库
        </Link>
        <Link href="/analytics" style={{ color: '#2563eb', fontSize: 13 }}>
          错题看板
        </Link>
        <Link href="/settings" style={{ color: '#2563eb', fontSize: 13 }}>
          模型供应商
        </Link>
      </div>

      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
        {canvases.map((canvas) => (
          <li key={canvas.id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12 }}>
            <Link href={`/c/${canvas.id}`} style={{ color: '#2563eb', fontWeight: 600 }}>
              {canvas.title}
            </Link>
            <span style={{ color: '#9ca3af', fontSize: 12, marginLeft: 8 }}>{canvas.id}</span>
          </li>
        ))}
        {canvases.length === 0 && <li style={{ color: '#9ca3af' }}>还没有画布，点上面的按钮新建一张。</li>}
      </ul>
    </main>
  )
}
