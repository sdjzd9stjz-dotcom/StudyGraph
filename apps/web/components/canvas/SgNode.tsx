'use client'

import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useRef, useState } from 'react'

import { NODE_PORTS, validateConnection } from '../../../../packages/contracts/src/client'
import type { NodeType } from '../../../../packages/contracts/src/client'
import { ADVANCED_NODES, PRIMARY_NODES, PROMPT_FIELD, nodeColor, nodeHint, paramFieldsFor } from '../../lib/canvas-meta'
import type { ParamField } from '../../lib/canvas-meta'

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
  /** GATE 专用：放行 / 拒绝。其它节点类型没有这两个按钮。 */
  onGateDecision?: (nodeId: string, approved: boolean) => void
  /** 保存节点参数（题型识别、变式等需要填题目原文） */
  onSaveParams?: (nodeId: string, params: Record<string, unknown>) => void
  /** 打开这个节点的对话面板（每个节点自己就是一个会话） */
  onChat?: (nodeId: string) => void
  /** LECTURE 专用：导出讲义 PDF（桌面版走主进程打印） */
  onExport?: (nodeId: string) => void
  /** 节点当前参数，用于输入框回填 */
  params?: Record<string, unknown> | null
  /** GATE 当前是否已放行（来自 params.approved） */
  gateApproved?: boolean
  /** GATE 的拒绝理由（来自 params.note） */
  gateNote?: string | null
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
export function SgNode({ id, data, selected }: NodeProps) {
  const d = data as SgNodeData
  const [hover, setHover] = useState(false)
  /**
   * 面板钉住：光标进了输入框就锁定展开，离开面板才解除。
   *
   * 之前只认 mouseenter/mouseleave：光标一离开节点边框（比如点到输入框里
   * 但鼠标划出去、或者节点的重排让位置变了），面板立刻收起，
   * 正在输入的内容被藏起来，继续打字就打到别处 —— 用户实际遇到的现象。
   */
  const [pinned, setPinned] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [hoverPort, setHoverPort] = useState<{ side: 'in' | 'out'; name: string; type: string; top: number } | null>(null)
  const color = nodeColor(d.nodeType)

  /**
   * 参数草稿：把已有 params 摊平成字符串，供输入框直接绑定。
   *
   * 用草稿而不是直接读写 params：参数有数字、数组、布尔三种形态，
   * 输入框里只能放字符串。改动期间保持草稿，点「保存参数」才转回类型写库 ——
   * 中途每敲一个字就提交，会让"12"先变成 1 再变成 12，节点被无谓标脏。
   */
  const [draft, setDraft] = useState<Record<string, string>>(() => flattenParams(d.nodeType, d.params))
  // 提示词对每个节点都开放；类型专属参数排在后面
  const fields = [PROMPT_FIELD, ...paramFieldsFor(d.nodeType)]
  const connectionInputs = d.inputs.filter((port) => !port.external)

  /**
   * 缩略态自适应（用户 2026-11-23 要求）。
   *
   * 之前是死宽 232 + 死高 168 + 滚动条：内容一多就得拖滑轨才能看全，
   * 一屏也看不出"这张卡在讲什么"。现在按内容量估一个尺寸：
   *   · 行数少 → 窄一点，省画布空间
   *   · 行数多 → 先加宽（最多 320，再宽就横跨半屏），再加高（最多 420）
   * 超过上限才滚动 —— 极长产物不可能无限撑开，否则画布没法看。
   */
  const summary = d.outputSummary ?? ''
  const lines = summary.length === 0 ? [] : summary.split('\n')
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0)
  // 每行约 15 个汉字宽；长行给更宽的卡片，短行保持紧凑
  const nodeWidth = lines.length === 0 ? 232 : longest > 34 ? 320 : longest > 22 ? 276 : 232
  // 232 宽时一行约 15 字，宽卡片约 21 字 —— 换行后行数会变多，粗略换算
  const charsPerLine = Math.round(nodeWidth / 15)
  const wrappedLines = lines.reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0)
  const outputMaxHeight = Math.min(420, Math.max(120, wrappedLines * 19 + 18))
  const compatible = d.connectHighlight === 'compatible'
  const incompatible = d.connectHighlight === 'incompatible'

  return (
    <div
      data-testid="sg-node"
      data-node-type={d.nodeType}
      data-status={d.status}
      data-connect-highlight={d.connectHighlight ?? undefined}
      ref={rootRef}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false)
        /**
         * 光标离开了，但只要面板里还有焦点（正在打字）就保持展开；
         * 否则收起。用"焦点是否还在本节点内"判断，而不是只看 pinned ——
         * 之前 pinned 一旦为真、焦点又落回 body（点过保存按钮就会），
         * 就再也没有代码把它设回 false，面板永远不收起（真实反馈）。
         */
        window.setTimeout(() => {
          const root = rootRef.current
          const active = document.activeElement as HTMLElement | null
          const inside = Boolean(root && active && active !== document.body && root.contains(active))
          if (!inside) {
            if (active && active !== document.body) active.blur()
            setPinned(false)
          }
        }, 0)
      }}
      style={{
        position: 'relative',
        width: nodeWidth,
        background: '#fff',
        borderRadius: 10,
        /**
         * 选中态：以**节点自身**为单位高亮，不靠库默认的虚线包围盒。
         *
         * 视觉分三层，缩到 60% 也还看得见：
         *   1. 2px 边框换成主色（挑颜色之外再靠粗细区分）
         *   2. 3px 外发光环 —— 多个节点同时选中时，环与环之间不互相吞掉
         *   3. 左上角一个实心勾标 —— 黑白色差最稳，色弱也能分辨
         */
        border: `2px solid ${
          d.running ? '#f59e0b' : compatible ? '#22c55e' : selected ? '#2563eb' : color
        }`,
        boxShadow: selected
          ? '0 0 0 3px rgba(37,99,235,0.32), 0 10px 24px rgba(37,99,235,0.20)'
          : compatible
            ? '0 0 0 3px rgba(34,197,94,0.28), 0 6px 18px rgba(15,23,42,0.13)'
            : hover
              ? '0 6px 18px rgba(15,23,42,0.13)'
              : '0 1px 3px rgba(15,23,42,0.08)',
        // 接不上的压暗，但不是消失：用户仍能看见它在哪
        opacity: incompatible ? 0.4 : 1,
        transform: compatible ? 'scale(1.03)' : 'scale(1)',
        fontSize: 12,
        transition: 'box-shadow .12s, opacity .12s, transform .12s, border-color .12s',
        // 选中时抬到其它节点之上，外发光不会被相邻节点盖住
        zIndex: selected ? 5 : undefined,
        // 不能用 overflow:hidden —— ReactFlow 的端口跨在边框上，裁掉就点不中（实测拖不出线）。
        // 圆角裁剪交给内部的标题栏/内容块自己处理。
      }}
    >
      {/* 选中标记：左上角实心圆 + 勾。颜色之外还有形状，缩小时也认得出 */}
      {selected && (
        <div
          data-testid="node-selected-badge"
          style={{
            position: 'absolute',
            top: -10,
            left: -10,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: '#2563eb',
            border: '2px solid #fff',
            boxShadow: '0 2px 6px rgba(37,99,235,0.4)',
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            lineHeight: 1,
            pointerEvents: 'none',
          }}
        >
          ✓
        </div>
      )}

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
            title="就这个节点的内容提问"
            data-testid={`chat-node-${id}`}
            onClick={(event) => {
              event.stopPropagation()
              d.onChat?.(id)
            }}
            style={iconButton}
          >
            💬
          </button>
          <button
            type="button"
            title={d.running ? '正在运行…' : '运行这个节点'}
            data-testid={`run-node-${id}`}
            data-running={d.running ? 'true' : 'false'}
            disabled={d.running === true}
            onClick={(event) => {
              event.stopPropagation()
              d.onRun?.(id)
            }}
            style={{
              ...iconButton,
              cursor: d.running ? 'default' : 'pointer',
              // 运行中给一个明确的"正在转"，比按钮变灰更能说明"它在干活"
              background: d.running ? 'rgba(255,255,255,0.22)' : iconButton.background,
            }}
          >
            {/*
              运行中换成一个转圈的缺口环。
              用 CSS 动画而不是文字"…"：节点跑 10 秒以上时，转圈是唯一能持续
              传达"还在进行"的反馈，静态符号看起来像卡住了。
            */}
            {d.running ? (
              <span
                data-testid={`run-spinner-${id}`}
                aria-label="运行中"
                style={{
                  display: 'inline-block',
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  border: '1.6px solid rgba(255,255,255,0.35)',
                  borderTopColor: '#fff',
                  animation: 'sg-spin .7s linear infinite',
                  verticalAlign: 'middle',
                }}
              />
            ) : (
              '▶'
            )}
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

      {/*
        GATE 的闸门条。
        放在标题栏下方而不是悬停面板里：闸门是"必须做决定"的节点，
        把决定入口藏进悬停，学生会以为它坏了。
      */}
      {d.nodeType === 'GATE' && (
        <div
          data-testid={`gate-bar-${id}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 9px',
            background: d.gateApproved ? '#ecfdf5' : '#fffbeb',
            borderBottom: '1px solid #e5e7eb',
            fontSize: 11,
          }}
        >
          <span style={{ color: d.gateApproved ? '#047857' : '#b45309', fontWeight: 600 }}>
            {d.gateApproved ? '已放行' : '待确认'}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            <button
              type="button"
              data-testid={`gate-approve-${id}`}
              onClick={(event) => {
                event.stopPropagation()
                d.onGateDecision?.(id, true)
              }}
              style={gateButton('#059669')}
            >
              放行
            </button>
            <button
              type="button"
              data-testid={`gate-reject-${id}`}
              onClick={(event) => {
                event.stopPropagation()
                d.onGateDecision?.(id, false)
              }}
              style={gateButton('#dc2626')}
            >
              拒绝
            </button>
          </span>
        </div>
      )}

      {/*
        导出讲义的打印入口。
        放在标题栏下方而不是悬停面板里：导出是这类节点的**主要动作**，
        藏起来等于没有；而且中文按钮在 18×18 的图标位里放不下。
      */}
      {d.nodeType === 'LECTURE' && (
        <div
          data-testid={`lecture-bar-${id}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 9px',
            background: '#f0fdfa',
            borderBottom: '1px solid #ccfbf1',
            fontSize: 11,
          }}
        >
          <span style={{ color: '#0f766e', fontWeight: 600 }}>
            {d.outputSummary?.startsWith('📘') ? '讲义已生成' : '运行后生成讲义'}
          </span>
          <button
            type="button"
            data-testid={`export-lecture-${id}`}
            onClick={(event) => {
              event.stopPropagation()
              d.onExport?.(id)
            }}
            style={{ ...gateButton('#0f766e'), marginLeft: 'auto' }}
          >
            导出 PDF
          </button>
        </div>
      )}

      {/* 提示词窗：悬停才展开 */}
      <div
        data-testid="prompt-panel"
        data-expanded={hover || pinned ? 'true' : 'false'}
        onFocusCapture={() => setPinned(true)}
        onBlurCapture={(event) => {
          // 焦点还在面板内部（从一个输入框切到另一个）时不解除
          const next = event.relatedTarget as Node | null
          if (!next || !event.currentTarget.contains(next)) setPinned(false)
        }}
        onPointerDownCapture={() => setPinned(true)}
        style={{
          // 有参数要填的节点给更高的展开高度：题目原文是多行的，128px 装不下
          maxHeight: hover || pinned ? (fields.length > 0 ? 300 : 128) : 0,
          opacity: hover || pinned ? 1 : 0,
          overflow: 'hidden',
          transition: 'max-height .16s ease, opacity .12s',
          borderBottom: hover || pinned ? '1px solid #e5e7eb' : 'none',
          background: '#f8fafc',
        }}
      >
        <div style={{ padding: '7px 9px', maxHeight: 292, overflowY: 'auto' }}>
          {/* ① 参数：这六个节点处理的是某一道具体的题，原文没法从上游拿 */}
          {fields.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: '#64748b', marginBottom: 4 }}>节点参数</div>
              <div style={{ display: 'grid', gap: 4 }}>
                {fields.map((field) => {
                  const value = draft[field.key] ?? ''
                  const onChange = (next: string) => setDraft((current) => ({ ...current, [field.key]: next }))
                  if (field.type === 'textarea') {
                    return (
                      <label key={field.key} style={fieldLabel}>
                        <span>{field.label}</span>
                        <textarea
                          data-testid={`param-${id}-${field.key}`}
                          value={value}
                          placeholder={field.placeholder}
                          onChange={(event) => onChange(event.target.value)}
                          onPointerDown={(event) => event.stopPropagation()}
                          rows={3}
                          style={{ ...fieldInput, resize: 'vertical', fontFamily: 'inherit' }}
                        />
                      </label>
                    )
                  }
                  if (field.type === 'bool') {
                    return (
                      <label key={field.key} style={{ ...fieldLabel, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                        <input
                          type="checkbox"
                          data-testid={`param-${id}-${field.key}`}
                          checked={value === 'true'}
                          onChange={(event) => onChange(event.target.checked ? 'true' : 'false')}
                        />
                        <span>{field.label}</span>
                      </label>
                    )
                  }
                  return (
                    <label key={field.key} style={fieldLabel}>
                      <span>{field.label}</span>
                      <input
                        data-testid={`param-${id}-${field.key}`}
                        type={field.type === 'number' ? 'number' : 'text'}
                        value={value}
                        placeholder={field.placeholder}
                        onChange={(event) => onChange(event.target.value)}
                        onPointerDown={(event) => event.stopPropagation()}
                        style={fieldInput}
                      />
                    </label>
                  )
                })}
              </div>
              <button
                type="button"
                data-testid={`save-params-${id}`}
                onClick={(event) => {
                  event.stopPropagation()
                  d.onSaveParams?.(id, buildParams(fields, draft, d.params))
                }}
                style={saveButton}
              >
                保存参数
              </button>
            </div>
          )}

          {/* ② 技能 */}
          <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3 }}>绑定技能</div>
          {d.skills.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {d.skills.map((skill) => (
                <span key={skill} style={{ background: '#e0e7ff', color: '#3730a3', borderRadius: 4, padding: '1px 5px', fontSize: 10 }}>
                  {skill}
                </span>
              ))}
            </div>
          ) : (
            <div style={{ color: '#94a3b8', fontSize: 11 }}>未绑定技能</div>
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
            编辑技能绑定
          </button>
        </div>
      </div>

      {/* 输出内容：常驻。跑过的节点显示成一张"带解释的卡片"，没跑过显示提示 */}
      <div style={{ padding: '7px 9px' }}>
        {d.title && <div style={{ fontWeight: 600, marginBottom: 3 }}>{d.title}</div>}
        <div
          data-testid="node-output"
          data-has-content={d.outputSummary ? 'true' : 'false'}
          style={{
            color: d.outputSummary ? '#334155' : '#94a3b8',
            fontSize: 11,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            // 自适应高度：内容少就矮，内容多先加高到 420 再滚动
            maxHeight: d.outputSummary ? outputMaxHeight : undefined,
            overflowY: d.outputSummary ? 'auto' : undefined,
            background: d.outputSummary ? '#f8fafc' : 'transparent',
            border: d.outputSummary ? '1px solid #e2e8f0' : 'none',
            borderRadius: d.outputSummary ? 6 : 0,
            padding: d.outputSummary ? '6px 8px' : 0,
          }}
        >
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

/** 已有 params → 输入框能绑定的字符串 */
function flattenParams(nodeType: string, params: Record<string, unknown> | null | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const field of paramFieldsFor(nodeType)) {
    const raw = params?.[field.key]
    if (raw === undefined || raw === null) continue
    if (Array.isArray(raw)) result[field.key] = raw.join(', ')
    else if (typeof raw === 'boolean') result[field.key] = raw ? 'true' : 'false'
    else result[field.key] = String(raw)
  }
  return result
}

/**
 * 草稿 → params。空字符串一律**不写进 params**，不是写成空串。
 *
 * 理由：执行器用 `params.count ?? 5` 这类写法取默认值，
 * 空串会让 `??` 失效（空串不是 null），然后 Number('') = 0 把数量变成 0。
 */
function buildParams(
  fields: readonly ParamField[],
  draft: Record<string, string>,
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  // 从已有 params 出发再覆盖：表单里没有的字段（课件的 localPath、闸门的 approved）必须原样留着。
  // 用空对象重建会把它们一起抹掉 —— 保存一次提示词就把课件路径弄丢，是最难查的那种坏法。
  const result: Record<string, unknown> = { ...(existing ?? {}) }
  for (const field of fields) {
    const value = (draft[field.key] ?? '').trim()
    if (field.type === 'bool') {
      // 布尔是显式的：false 也要写进去，否则执行器会当成没设
      result[field.key] = value === 'true'
      continue
    }
    if (value.length === 0) {
      // 清空 = 删掉这个字段，而不是写成空串（空串会让 `?? 默认值` 失效）
      delete result[field.key]
      continue
    }
    if (field.type === 'number') {
      const parsed = Number(value)
      result[field.key] = Number.isFinite(parsed) ? parsed : value
      continue
    }
    if (field.type === 'csv') {
      const items = value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean)
      if (items.length > 0) result[field.key] = items
      continue
    }
    result[field.key] = value
  }
  return result
}

const fieldLabel: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  fontSize: 10,
  color: '#475569',
}

const fieldInput: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 5px',
  border: '1px solid #cbd5e1',
  borderRadius: 4,
  background: '#fff',
  color: '#0f172a',
  width: '100%',
  boxSizing: 'border-box',
}

const saveButton: React.CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  border: 'none',
  borderRadius: 4,
  background: '#2563eb',
  color: '#fff',
  padding: '3px 9px',
  cursor: 'pointer',
}

/**
 * 闸门按钮。
 *
 * 不能复用 iconButton：那个是 18×18 的图标按钮（只放 ▶ / ✕），
 * 用它装两个汉字会被截成"放""拒"。闸门的两个动作必须写全，
 * 否则学生分不清哪个是放行。
 */
function gateButton(background: string): React.CSSProperties {
  return {
    border: 'none',
    borderRadius: 4,
    background,
    color: '#fff',
    fontSize: 11,
    lineHeight: '18px',
    padding: '0 8px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
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
