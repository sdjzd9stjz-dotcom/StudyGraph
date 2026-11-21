'use client'

import { useState } from 'react'

import type { NodeType } from '../../../../packages/contracts/src/client'
import { ADVANCED_NODES, PRIMARY_NODES } from '../../lib/canvas-meta'

export interface SkillView {
  id: string
  slug: string
  name: string
  description: string
  version: number
}

/**
 * 左侧栏：技能 + 节点（用户要求「侧栏是对应的 skill」）。
 *
 * 两段结构：
 *   · 技能：拖到节点上直接绑定（绑定会进指纹，下次执行必然重跑）
 *   · 节点：常用 6 个，高级折叠
 */
export function Sidebar({
  skills,
  onDragSkill,
  onDragNode,
  onAddNode,
}: {
  skills: SkillView[]
  onDragSkill: (skill: SkillView) => void
  onDragNode: (type: NodeType) => void
  onAddNode: (type: NodeType) => void
}) {
  const [showAdvanced, setShowAdvanced] = useState(false)

  return (
    <aside
      data-testid="canvas-sidebar"
      style={{ width: 216, borderRight: '1px solid #e2e8f0', background: '#fbfcfe', overflowY: 'auto', padding: '10px 10px 24px' }}
    >
      <SectionTitle>技能</SectionTitle>
      <div style={{ display: 'grid', gap: 5, marginBottom: 16 }}>
        {skills.length === 0 && <div style={{ fontSize: 11, color: '#94a3b8' }}>还没有技能</div>}
        {skills.map((skill) => (
          <div
            key={skill.id}
            data-testid={`sidebar-skill-${skill.slug}`}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('application/studygraph-skill', skill.id)
              onDragSkill(skill)
            }}
            title={`${skill.description}（拖到节点上绑定）`}
            style={{
              border: '1px solid #e0e7ff',
              background: '#eef2ff',
              borderRadius: 6,
              padding: '6px 8px',
              fontSize: 12,
              cursor: 'grab',
            }}
          >
            <div style={{ fontWeight: 600, color: '#3730a3' }}>{skill.name}</div>
            <div style={{ color: '#6366f1', fontSize: 10 }}>v{skill.version} · 拖到节点绑定</div>
          </div>
        ))}
      </div>

      <SectionTitle>节点</SectionTitle>
      <div style={{ display: 'grid', gap: 5 }}>
        {PRIMARY_NODES.map((node) => (
          <button
            key={node.type}
            type="button"
            data-testid={`sidebar-node-${node.type}`}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('application/studygraph-node', node.type)
              onDragNode(node.type)
            }}
            onClick={() => onAddNode(node.type)}
            style={nodeCard(node.color)}
          >
            <span style={{ width: 7, height: 7, borderRadius: 99, background: node.color, display: 'inline-block', marginRight: 7 }} />
            <span style={{ fontWeight: 600 }}>{node.label}</span>
            <div style={{ color: '#94a3b8', fontSize: 10, marginLeft: 14 }}>{node.hint}</div>
          </button>
        ))}
      </div>

      <button
        type="button"
        data-testid="toggle-advanced"
        onClick={() => setShowAdvanced((value) => !value)}
        style={{ marginTop: 12, width: '100%', border: '1px dashed #cbd5e1', background: 'transparent', borderRadius: 6, padding: '5px', fontSize: 11, color: '#64748b', cursor: 'pointer' }}
      >
        {showAdvanced ? '收起高级节点' : `高级节点 (${ADVANCED_NODES.length})`}
      </button>

      {showAdvanced && (
        <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
          {ADVANCED_NODES.map((node) => (
            <button
              key={node.type}
              type="button"
              data-testid={`sidebar-node-${node.type}`}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('application/studygraph-node', node.type)
                onDragNode(node.type)
              }}
              onClick={() => onAddNode(node.type)}
              style={{ ...nodeCard('#94a3b8'), padding: '5px 7px', fontSize: 11 }}
            >
              <span style={{ fontWeight: 500 }}>{node.label}</span>
              <div style={{ color: '#94a3b8', fontSize: 10 }}>{node.hint}</div>
            </button>
          ))}
        </div>
      )}
    </aside>
  )
}

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', letterSpacing: 1, marginBottom: 6 }}>{children}</div>
)

const nodeCard = (color: string): React.CSSProperties => ({
  display: 'block',
  width: '100%',
  textAlign: 'left',
  border: '1px solid #e2e8f0',
  background: '#fff',
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 12,
  cursor: 'grab',
  color: '#1f2937',
  borderLeft: `3px solid ${color}`,
})
