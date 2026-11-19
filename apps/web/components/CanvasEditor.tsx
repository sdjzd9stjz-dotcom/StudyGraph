'use client'

import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import type { Connection, Edge as FlowEdge, Node as FlowNode } from '@xyflow/react'
import { useCallback, useMemo, useRef } from 'react'

import { NODE_PORTS, NODE_TYPES } from '../../../packages/contracts/src/index'
import type { NodeType } from '../../../packages/contracts/src/index'
import { API_BASE_URL } from '../lib/api'
import { NODE_TYPE_LABELS, STATUS_COLORS } from '../lib/status'

interface PortView {
  name: string
  type: string
  external: boolean
}

interface SgData {
  nodeType: NodeType
  status: string
  inputs: PortView[]
  outputs: PortView[]
}

function SgNode({ data }: { data: SgData }) {
  const color = STATUS_COLORS[data.status] ?? '#9ca3af'
  const connectionInputs = data.inputs.filter((port) => !port.external)

  return (
    <div
      data-testid="sg-node"
      data-node-type={data.nodeType}
      data-status={data.status}
      style={{
        border: `2px solid ${color}`,
        borderRadius: 10,
        background: '#fff',
        width: 200,
        padding: '10px 12px',
        fontSize: 12,
      }}
    >
      {connectionInputs.map((port, index) => (
        <Handle
          key={port.name}
          id={port.name}
          type="target"
          position={Position.Left}
          style={{ top: 46 + index * 18, background: color }}
        />
      ))}
      {data.outputs.map((port, index) => (
        <Handle
          key={port.name}
          id={port.name}
          type="source"
          position={Position.Right}
          style={{ top: 46 + index * 18, background: color }}
        />
      ))}

      <div style={{ fontWeight: 700, marginBottom: 2 }}>{NODE_TYPE_LABELS[data.nodeType] ?? data.nodeType}</div>
      <div style={{ color: '#6b7280', marginBottom: 6 }}>
        {data.nodeType} · <span style={{ color }}>{data.status}</span>
      </div>

      {data.inputs.map((port) =>
        port.external ? (
          // 入口端口：数据来自粘贴/上传，不给连接点
          <div
            key={port.name}
            data-testid="external-slot"
            style={{
              border: '1px dashed #cbd5e1',
              borderRadius: 6,
              padding: '3px 6px',
              color: '#64748b',
              marginBottom: 4,
            }}
          >
            ⌸ 上传/粘贴 · {port.type}
          </div>
        ) : (
          <div key={port.name} style={{ color: '#64748b' }}>
            ← {port.name}: {port.type}
          </div>
        ),
      )}

      {data.outputs.map((port) => (
        <div key={port.name} style={{ color: '#64748b', textAlign: 'right' }}>
          {port.name}: {port.type} →
        </div>
      ))}
    </div>
  )
}

const nodeTypes = { sgNode: SgNode }

const portViews = (type: NodeType): Pick<SgData, 'inputs' | 'outputs'> => ({
  inputs: NODE_PORTS[type].inputs.map((port) => ({ name: port.name, type: port.type, external: port.external === true })),
  outputs: NODE_PORTS[type].outputs.map((port) => ({ name: port.name, type: port.type, external: port.external === true })),
})

function toFlowNode(node: {
  id: string
  type: string
  status: string
  posX: number
  posY: number
}): FlowNode {
  const type = node.type as NodeType
  return {
    id: node.id,
    type: 'sgNode',
    position: { x: node.posX, y: node.posY },
    data: { nodeType: type, status: node.status, ...portViews(type) } satisfies SgData,
  }
}

export interface CanvasEditorProps {
  canvasId: string
  token: string
  initialNodes: Array<{ id: string; type: string; status: string; posX: number; posY: number }>
  initialEdges: Array<{ id: string; fromNodeId: string; toNodeId: string; fromPort: string; toPort: string }>
}

function Inner({ canvasId, token, initialNodes, initialEdges }: CanvasEditorProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initialNodes.map(toFlowNode))
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(
    initialEdges.map(
      (edge): FlowEdge => ({
        id: edge.id,
        source: edge.fromNodeId,
        target: edge.toNodeId,
        sourceHandle: edge.fromPort,
        targetHandle: edge.toPort,
      }),
    ),
  )
  const wrapper = useRef<HTMLDivElement>(null)
  const { screenToFlowPosition } = useReactFlow()

  const onConnect = useCallback(
    async (connection: Connection) => {
      const response = await fetch(`${API_BASE_URL}/v1/canvases/${canvasId}/edges`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          fromNodeId: connection.source,
          toNodeId: connection.target,
          fromPort: connection.sourceHandle ?? undefined,
          toPort: connection.targetHandle ?? undefined,
        }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        const error = payload?.error
        alert(`连线被拒绝：${error?.code ?? response.status}\n${error?.message ?? ''}`)
        return
      }
      setEdges((current) =>
        addEdge(
          {
            id: String(payload.id),
            source: connection.source,
            target: connection.target,
            sourceHandle: connection.sourceHandle ?? undefined,
            targetHandle: connection.targetHandle ?? undefined,
          },
          current,
        ),
      )
    },
    [canvasId, setEdges, token],
  )

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()
      const type = event.dataTransfer.getData('application/studygraph-node') as NodeType
      if (!type) return

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const response = await fetch(`${API_BASE_URL}/v1/canvases/${canvasId}/nodes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ type, posX: position.x, posY: position.y }),
      })
      const created = await response.json().catch(() => null)
      if (!response.ok) {
        alert(`创建节点失败：${created?.error?.code ?? response.status}`)
        return
      }
      setNodes((current) => [...current, toFlowNode(created)])
    },
    [canvasId, screenToFlowPosition, setNodes, token],
  )

  const onNodeDragStop = useCallback(
    async (_event: unknown, node: FlowNode) => {
      await fetch(`${API_BASE_URL}/v1/nodes/${node.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ posX: Math.round(node.position.x), posY: Math.round(node.position.y) }),
      })
    },
    [token],
  )

  const palette = useMemo(() => NODE_TYPES.map((type) => ({ type, label: NODE_TYPE_LABELS[type] ?? type })), [])

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 190px)', borderTop: '1px solid #e5e7eb' }}>
      <aside style={{ width: 210, borderRight: '1px solid #e5e7eb', padding: 12, overflowY: 'auto' }}>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>拖到画布上创建（17 种）</div>
        {palette.map((item) => (
          <div
            key={item.type}
            data-testid="palette-item"
            data-node-type={item.type}
            draggable
            onDragStart={(event) => event.dataTransfer.setData('application/studygraph-node', item.type)}
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 6,
              padding: '6px 8px',
              marginBottom: 6,
              cursor: 'grab',
              fontSize: 12,
            }}
          >
            {item.label}
            <span style={{ color: '#9ca3af', marginLeft: 6 }}>{item.type}</span>
          </div>
        ))}
      </aside>

      <div ref={wrapper} style={{ flex: 1 }} onDrop={onDrop} onDragOver={(event) => event.preventDefault()}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  )
}

export function CanvasEditor(props: CanvasEditorProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  )
}
