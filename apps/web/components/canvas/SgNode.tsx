'use client'

import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useState } from 'react'

import { NODE_PORTS, validateConnection } from '../../../../packages/contracts/src/client'
import type { NodeType } from '../../../../packages/contracts/src/client'
import { ADVANCED_NODES, PRIMARY_NODES, nodeColor, nodeHint } from '../../lib/canvas-meta'

export interface SgNodeData {
  nodeType: string
  label: string
  status: string
  title: string | null
  /** 已绑定的 skill 名（悬停面板里显示） */
  skills: string[]
  /** 最后一段输出摘要（常驻栏） */
  outputSummary: string | null
  inputs: Array<{ name: string; type: string; external: boolean }>
  outputs: Array<{ name: string; type: string; external: boolean }>
  running?: boolean
  /**
   * 拖线中的高亮态（null = 没在拖线）。
   *   compatible   能接上 → 亮边框 + 轻微放大
   *   incompatible 接不上 → 压暗
   *   origin       起点自己 → 不动
   */
  connectHighlight?: 'origin' | 'compatible' | 'incompatible' | null
  /**
   * 端口级高亮：端口名 → 'ok'（能接）| 'no'（接不上）。
   * 拖线时才存在；null 表示没在拖线。
   */
  portState?: Record<string, 'ok' | 'no'> | null
  onRun?: (nodeId: string) => void
  onDelete?: (nodeId: string) => void
  onOpenPrompt?: (nodeId: string) => void
  [key: string]: unknown
}

/**
 * 画布节点（用户要求：分两栏，提示词窗悬停才显示）。
 *
 * 结构：
 *   ┌ 标题栏（类型 · 状态 · 运行/删除）
 *   ├ 提示词窗 —— **默认收起**，鼠标移上去才展开
 *   └ 输出内容 —— 常驻
 *
 * 为什么提示词窗要收起：提示词通常很长，常驻会把节点撑成一面墙，
 * 一屏放不下几个节点，就失去了"看思维链条"的意义。
 */
export function SgNode({ id, data }: NodeProps) {
  const d = data as SgNodeData
  const [hover, setHover] = useState(false)
  const [hoverPort, setHoverPort] = useState<{ side: 'in' | 'out'; name: string; type: string; top: number } | null>(null)
  const color = nodeColor(d.nodeType)
  const connectionInputs = d.inputs.filter((port) => !port.external)
  const compatible = d.connectHighlight === 'compatible'
  const incompatible = d.connectHighlight === 'incompatible'

  return (
    <div
      data-testid="sg-node"
      data-node-type={d.nodeType}
      data-status={d.status}
      data-connect-highlight={d.connectHighlight ?? undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        width: 232,
        background: '#fff',
        borderRadius: 10,
        border: `2px solid ${d.running ? '#f59e0b' : compatible ? '#22c55e' : color}`,
        // 能接上的：绿色描边 + 外发光 + 轻微放大，一眼就能看出"往这儿松手"
        boxShadow: compatible
          ? '0 0 0 3px rgba(34,197,94,0.28), 0 6px 18px rgba(15,23,42,0.13)'
          : hover
            ? '0 6px 18px rgba(15,23,42,0.13)'
            : '0 1px 3px rgba(15,23,42,0.08)',
        // 接不上的压暗，但不是消失：用户仍能看见它在哪
        opacity: incompatible ? 0.4 : 1,
        transform: compatible ? 'scale(1.03)' : 'scale(1)',
        fontSize: 12,
        transition: 'box-shadow .12s, opacity .12s, transform .12s, border-color .12s',
        // 不能用 overflow:hidden —— ReactFlow 的端口跨在边框上，裁掉就点不中（实测拖不出线）。
        // 圆角裁剪交给内部的标题栏/内容块自己处理。
      }}
    >
      {/* 能接上时在右上角给一个明确提示，颜色之外再加一层文字 */}
      {compatible && (
        <div
          data-testid="connect-badge"
          style={{ position: 'absolute', top: -9, right: -6, background: '#22c55e', color: '#fff', fontSize: 10, padding: '1px 6px', borderRadius: 99, fontWeight: 600 }}
        >
          可接入
        </div>
      )}
      {connectionInputs.map((port, index) => (
        <Handle
          key={port.name}
          id={port.name}
          type="target"
          position={Position.Left}
          data-port-state={d.portState?.[port.name] ?? undefined}
          style={handleStyle(d.portState?.[port.name], color, 28 + index * 16)}
          onMouseEnter={() => setHoverPort({ side: 'in', name: port.name, type: port.type, top: 28 + index * 16 })}
          onMouseLeave={() => setHoverPort(null)}
        />
      ))}
      {d.outputs.map((port, index) => (
        <Handle
          key={port.name}
          id={port.name}
          type="source"
          position={Position.Right}
          data-port-state={d.portState?.[port.name] ?? undefined}
          style={handleStyle(d.portState?.[port.name], color, 28 + index * 16)}
          onMouseEnter={() => setHoverPort({ side: 'out', name: port.name, type: port.type, top: 28 + index * 16 })}
          onMouseLeave={() => setHoverPort(null)}
        />
      ))}

      {/* 端口悬停提示：一根小圆点不告诉用户它是什么类型、能接什么，只能靠试 */}
      {hoverPort && !compatible && (
        <div
          data-testid="port-tooltip"
          style={{
            position: 'absolute',
            top: hoverPort.top - 6,
            ...(hoverPort.side === 'in' ? { right: '100%', marginRight: 14 } : { left: '100%', marginLeft: 14 }),
            zIndex: 20,
            background: '#0f172a',
            color: '#fff',
            borderRadius: 6,
            padding: '5px 9px',
            fontSize: 11,
            lineHeight: 1.55,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            boxShadow: '0 6px 16px rgba(15,23,42,0.24)',
          }}
        >
          <div style={{ fontWeight: 600 }}>
            {hoverPort.side === 'in' ? '输入' : '输出'} · {hoverPort.name}
          </div>
          <div style={{ color: '#94a3b8' }}>类型 {hoverPort.type}</div>
          {portTargets(d.nodeType as NodeType, hoverPort.side, hoverPort.name).length > 0 ? (
            <div style={{ color: '#86efac' }}>
              可接：{portTargets(d.nodeType as NodeType, hoverPort.side, hoverPort.name).join('、')}
            </div>
          ) : (
            <div style={{ color: '#fca5a5' }}>没有节点能接这根端口</div>
          )}
        </div>
      )}

      {/* 标题栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 9px', background: color, color: '#fff' }}>
        <span style={{ fontWeight: 700, fontSize: 12 }}>{d.label}</span>
        <span style={{ opacity: 0.85, fontSize: 10 }}>{d.status}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button
            type="button"
            title="运行这个节点"
            data-testid={`run-node-${id}`}
            onClick={(event) => {
              event.stopPropagation()
              d.onRun?.(id)
            }}
            style={iconButton}
          >
            ▶
          </button>
          <button
            type="button"
            title="删除节点"
            data-testid={`delete-node-${id}`}
            onClick={(event) => {
              event.stopPropagation()
              d.onDelete?.(id)
            }}
            style={iconButton}
          >
            ✕
          </button>
        </span>
      </div>

      {/* 提示词窗：悬停才展开 */}
      <div
        data-testid="prompt-panel"
        data-expanded={hover ? 'true' : 'false'}
        style={{
          maxHeight: hover ? 128 : 0,
          opacity: hover ? 1 : 0,
          overflow: 'hidden',
          transition: 'max-height .16s ease, opacity .12s',
          borderBottom: hover ? '1px solid #e5e7eb' : 'none',
          background: '#f8fafc',
        }}
      >
        <div style={{ padding: '7px 9px' }}>
          <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>提示词 / 绑定技能</div>
          {d.skills.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {d.skills.map((skill) => (
                <span key={skill} style={{ background: '#e0e7ff', color: '#3730a3', borderRadius: 4, padding: '1px 5px', fontSize: 10 }}>
                  {skill}
                </span>
              ))}
            </div>
          ) : (
            <div style={{ color: '#94a3b8', fontSize: 11 }}>未绑定技能 · 点此编辑</div>
          )}
          <button
            type="button"
            data-testid={`open-prompt-${id}`}
            onClick={(event) => {
              event.stopPropagation()
              d.onOpenPrompt?.(id)
            }}
            style={{ marginTop: 6, fontSize: 11, border: '1px solid #cbd5e1', background: '#fff', borderRadius: 4, padding: '2px 7px', cursor: 'pointer' }}
          >
            编辑提示词
          </button>
        </div>
      </div>

      {/* 输出内容：常驻 */}
      <div style={{ padding: '7px 9px' }}>
        {d.title && <div style={{ fontWeight: 600, marginBottom: 3 }}>{d.title}</div>}
        <div data-testid="node-output" style={{ color: d.outputSummary ? '#334155' : '#94a3b8', fontSize: 11, lineHeight: 1.5 }}>
          {d.outputSummary ?? nodeHint(d.nodeType)}
        </div>
        {d.inputs.some((port) => port.external) && (
          <div style={{ marginTop: 5, border: '1px dashed #cbd5e1', borderRadius: 5, padding: '2px 6px', color: '#64748b', fontSize: 10 }}>
            ⌸ 点击上传课件
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 这根端口能接到哪些节点。
 *
 * 判定复用 `validateConnection`（与手工连线、服务端同一套），
 * 所以提示里说的和实际能不能连一定一致 —— 不能出现"提示说能接、松手被拒"。
 */
function portTargets(nodeType: NodeType, side: 'in' | 'out', portName: string): string[] {
  const candidates = [...PRIMARY_NODES, ...ADVANCED_NODES]
  const result: string[] = []

  for (const candidate of candidates) {
    if (candidate.type === nodeType) continue
    const ports = side === 'out' ? NODE_PORTS[candidate.type]?.inputs ?? [] : NODE_PORTS[candidate.type]?.outputs ?? []
    const ok = ports.some((port) => {
      if (port.external) return false
      return side === 'out'
        ? validateConnection({ fromType: nodeType, fromPort: portName, toType: candidate.type, toPort: port.name }).ok
        : validateConnection({ fromType: candidate.type, fromPort: port.name, toType: nodeType, toPort: portName }).ok
    })
    if (ok) result.push(candidate.label)
  }
  return result
}

/**
 * 端口样式：拖线时把"能接的那根"放大变绿，"接不上的"压暗。
 *
 * 为什么要端口级而不是只到节点级：一个节点可能有好几根输入口
 * （EXTRACT 有两根），只把整块染绿，用户还是不知道该往哪根松手。
 */
function handleStyle(state: 'ok' | 'no' | undefined, color: string, top: number): React.CSSProperties {
  const base: React.CSSProperties = { top, width: 9, height: 9, background: color }
  if (state === 'ok') {
    return {
      ...base,
      background: '#22c55e',
      width: 15,
      height: 15,
      // 绿环：即使端口本身很小，也能在缩小的画布上一眼看到
      boxShadow: '0 0 0 4px rgba(34,197,94,0.35), 0 0 8px rgba(34,197,94,0.6)',
      border: '2px solid #fff',
      transition: 'width .1s, height .1s, box-shadow .1s',
    }
  }
  if (state === 'no') {
    return { ...base, opacity: 0.22, transition: 'opacity .1s' }
  }
  return base
}

const iconButton: React.CSSProperties = {
  width: 18,
  height: 18,
  lineHeight: '16px',
  padding: 0,
  border: '1px solid rgba(255,255,255,0.55)',
  borderRadius: 4,
  background: 'transparent',
  color: '#fff',
  fontSize: 10,
  cursor: 'pointer',
}
