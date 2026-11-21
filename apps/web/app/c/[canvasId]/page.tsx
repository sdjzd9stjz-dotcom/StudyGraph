import Link from 'next/link'

import { CanvasWorkbench } from '../../../components/canvas/CanvasWorkbench'
import { SourceUploader } from '../../../components/SourceUploader'
import { API_BASE_URL, fetchCanvas, fetchCanvasSkills, fetchGroups, serverToken } from '../../../lib/api'

export const dynamic = 'force-dynamic'

export default async function CanvasPage({ params }: { params: { canvasId: string } }) {
  const [canvas, groupsPayload, skillsPayload] = await Promise.all([
    fetchCanvas(params.canvasId),
    fetchGroups(params.canvasId),
    fetchCanvasSkills(params.canvasId),
  ])

  if (!canvas) {
    return (
      <main style={{ padding: 32 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>画布不存在或无权访问</h1>
        <Link href="/" style={{ color: '#2563eb' }}>
          返回首页
        </Link>
      </main>
    )
  }

  return (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#f8fafc' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 16px',
          borderBottom: '1px solid #e2e8f0',
          background: '#fff',
        }}
      >
        <Link href="/" style={{ color: '#64748b', fontSize: 13, textDecoration: 'none' }}>
          ← 全部画布
        </Link>
        <h1 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{canvas.title}</h1>
        <span style={{ color: '#cbd5e1', fontSize: 11 }}>{canvas.nodes.length} 个节点</span>

        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <SourceUploader canvasId={canvas.id} apiBaseUrl={API_BASE_URL} token={serverToken()} />
          <Link href="/settings" style={{ color: '#2563eb', fontSize: 12, textDecoration: 'none' }}>
            模型供应商
          </Link>
          <Link href="/review" style={{ color: '#2563eb', fontSize: 12, textDecoration: 'none' }}>
            今日到期
          </Link>
        </span>
      </header>

      <CanvasWorkbench
        canvasId={canvas.id}
        apiBaseUrl={API_BASE_URL}
        token={serverToken()}
        initialNodes={canvas.nodes.map((node) => ({
          id: node.id,
          type: node.type,
          title: node.title,
          status: node.status,
          posX: node.posX,
          posY: node.posY,
        }))}
        initialEdges={canvas.edges.map((edge) => ({
          id: edge.id,
          fromNodeId: edge.fromNodeId,
          toNodeId: edge.toNodeId,
          fromPort: edge.fromPort,
          toPort: edge.toPort,
        }))}
        initialGroups={groupsPayload}
        skills={skillsPayload.skills}
        nodeSkills={skillsPayload.nodeSkills}
      />
    </main>
  )
}
