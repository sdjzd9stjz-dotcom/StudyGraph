import Link from 'next/link'

import { CanvasWorkbench } from '../../../components/canvas/CanvasWorkbench'
import { ConceptPanel } from '../../../components/ConceptPanel'
import { CanvasAiConfig } from '../../../components/canvas/CanvasAiConfig'
import { SourceUploader } from '../../../components/SourceUploader'
import { API_BASE_URL, fetchCanvas, fetchCanvasConcepts, fetchCanvasSkills, fetchGroups, serverToken } from '../../../lib/api'

export const dynamic = 'force-dynamic'

export default async function CanvasPage({ params }: { params: { canvasId: string } }) {
  const [canvas, groupsPayload, skillsPayload, concepts] = await Promise.all([
    fetchCanvas(params.canvasId),
    fetchGroups(params.canvasId),
    fetchCanvasSkills(params.canvasId),
    fetchCanvasConcepts(params.canvasId),
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
          {/* 画布里最需要教程：不知道从哪下手是新手卡住的第一步 */}
          <Link
            href="/guide"
            data-testid="guide-entry-canvas"
            style={{ color: '#0f766e', fontSize: 12, textDecoration: 'none', fontWeight: 600 }}
          >
            📖 教程
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
          params: node.params ?? null,
          outputText: node.outputText ?? null,
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

      {/**
        * 概念卡面板（含人工确认）。
        * 放在画布下方而不是侧栏：确认概念是"出题之前"的一次性动作，
        * 不需要常驻视线，但找不到就会卡住整条链路（真实反馈：出题一直失败）。
        */}
      <CanvasAiConfig canvasId={canvas.id} apiBaseUrl={API_BASE_URL} token={serverToken()} />

      <details data-testid="concept-panel-wrapper" style={{ borderTop: '1px solid #e2e8f0', background: '#fff' }}>
        <summary style={{ cursor: 'pointer', padding: '8px 16px', fontSize: 13, color: '#334155' }}>
          概念卡（{concepts.length}）—— 出题前需要在这里确认
        </summary>
        <div style={{ padding: '0 16px 16px' }}>
          <ConceptPanel
            canvasId={canvas.id}
            apiBaseUrl={API_BASE_URL}
            token={serverToken()}
            initialConcepts={concepts}
          />
        </div>
      </details>
    </main>
  )
}
