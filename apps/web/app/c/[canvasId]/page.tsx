import Link from 'next/link'

import { CanvasEditor } from '../../../components/CanvasEditor'
import { ConceptPanel } from '../../../components/ConceptPanel'
import { NODE_PORTS, NODE_TYPES } from '../../../../../packages/contracts/src/client'
import type { NodeType } from '../../../../../packages/contracts/src/client'
import { API_BASE_URL, fetchCanvas, fetchCanvasConcepts, serverToken } from '../../../lib/api'
import { NODE_TYPE_LABELS, STATUS_COLORS } from '../../../lib/status'

export const dynamic = 'force-dynamic'

export default async function CanvasPage({ params }: { params: { canvasId: string } }) {
  const canvas = await fetchCanvas(params.canvasId)
  const concepts = canvas ? await fetchCanvasConcepts(canvas.id) : []

  if (!canvas) {
    return (
      <main style={{ padding: 32 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>画布不存在或无权访问</h1>
        <p style={{ color: '#6b7280' }}>canvasId = {params.canvasId}</p>
        <Link href="/" style={{ color: '#2563eb' }}>
          返回首页
        </Link>
      </main>
    )
  }

  return (
    <main>
      <header style={{ padding: '16px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>{canvas.title}</h1>
          <span style={{ color: '#9ca3af', fontSize: 12 }}>{canvas.id}</span>
          <Link href="/" style={{ color: '#2563eb', fontSize: 13, marginLeft: 'auto' }}>
            返回首页
          </Link>
        </div>

        {/* 服务端渲染的节点清单：方便无浏览器环境核对状态与配色 */}
        <section data-testid="node-list" style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {canvas.nodes.map((node) => (
            <span
              key={node.id}
              data-testid="node-chip"
              data-node-type={node.type}
              data-status={node.status}
              style={{
                border: `2px solid ${STATUS_COLORS[node.status] ?? '#9ca3af'}`,
                borderRadius: 999,
                padding: '2px 10px',
                fontSize: 12,
              }}
            >
              {NODE_TYPE_LABELS[node.type] ?? node.type} · {node.status}
            </span>
          ))}
          {canvas.nodes.length === 0 && <span style={{ color: '#9ca3af', fontSize: 12 }}>画布是空的</span>}
        </section>

        {/* 入口端口清单：卡片由 ReactFlow 客户端渲染，这里用同一份 NODE_PORTS 在服务端列出来，
            方便核对"入口端口 = 上传/粘贴槽、不给连接点"。 */}
        <section data-testid="entry-ports" style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {canvas.nodes.flatMap((node) => {
            const ports = NODE_PORTS[node.type as NodeType]?.inputs.filter((port) => port.external) ?? []
            return ports.map((port) => (
              <span
                key={`${node.id}-${port.name}`}
                data-testid="external-slot"
                data-node-type={node.type}
                style={{
                  border: '1px dashed #cbd5e1',
                  borderRadius: 6,
                  padding: '1px 8px',
                  fontSize: 11,
                  color: '#64748b',
                }}
              >
                {node.type}.{port.name}：上传/粘贴槽（无连接点）
              </span>
            ))
          })}
        </section>

        <div style={{ marginTop: 8, fontSize: 12, color: '#9ca3af' }}>
          调色板共 {NODE_TYPES.length} 种节点：{NODE_TYPES.join(' / ')}
        </div>
      </header>

      <div style={{ padding: '8px 24px 16px' }}>
        <ConceptPanel canvasId={canvas.id} apiBaseUrl={API_BASE_URL} token={serverToken()} initialConcepts={concepts} />
      </div>

      <CanvasEditor
        canvasId={canvas.id}
        apiBaseUrl={API_BASE_URL}
        token={serverToken()}
        initialNodes={canvas.nodes.map((node) => ({
          id: node.id,
          type: node.type,
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
      />
    </main>
  )
}
