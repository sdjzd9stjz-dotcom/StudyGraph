import Link from 'next/link'

import { ProblemLibrary } from '../../components/ProblemLibrary'
import { API_BASE_URL, fetchCanvasList, fetchProblems, serverToken } from '../../lib/api'

export const dynamic = 'force-dynamic'

/**
 * 题库（M6）。
 *
 * 默认打开最近一张画布；没有画布时说清"先建一张画布"，
 * 而不是渲染一个空列表让人以为加载失败。
 */
export default async function ProblemsPage({ searchParams }: { searchParams: { canvasId?: string } }) {
  const canvases = await fetchCanvasList()
  const canvasId = searchParams.canvasId ?? canvases[0]?.id
  const problems = canvasId ? await fetchProblems(canvasId) : []

  return (
    <main style={{ padding: 32, maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>题库</h1>
        {canvasId && <span style={{ fontSize: 12, color: '#9ca3af' }}>{problems.length} 道题</span>}
        <Link href="/analytics" style={{ color: '#2563eb', fontSize: 13, marginLeft: 'auto' }}>
          错题看板
        </Link>
        <Link href="/" style={{ color: '#2563eb', fontSize: 13 }}>
          返回首页
        </Link>
      </div>

      {canvases.length === 0 ? (
        <div data-testid="no-canvas" style={{ border: '1px dashed #d1d5db', borderRadius: 8, padding: 24, color: '#9ca3af', fontSize: 13 }}>
          还没有画布。先回首页建一张，再在画布上跑出题节点。
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
            {canvases.map((canvas) => (
              <Link
                key={canvas.id}
                href={`/problems?canvasId=${canvas.id}`}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  borderRadius: 999,
                  textDecoration: 'none',
                  border: '1px solid #e5e7eb',
                  background: canvas.id === canvasId ? '#eff6ff' : '#fff',
                  color: canvas.id === canvasId ? '#1d4ed8' : '#6b7280',
                }}
              >
                {canvas.title}
              </Link>
            ))}
          </div>

          <ProblemLibrary canvasId={canvasId!} problems={problems} apiBaseUrl={API_BASE_URL} token={serverToken()} />
        </>
      )}
    </main>
  )
}
