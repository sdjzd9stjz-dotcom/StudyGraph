'use client'

import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'

/**
 * 画布上的"组"节点。
 *
 * 两种形态（用户 2026-11-24 要求）：
 *   展开 —— 它是一个**虚线框**，左上角写着名字，右侧有出点。框内是成员节点。
 *   收起 —— 全部成员叠到框的左上角，然后框本身变成一张叠放卡片。
 *
 * 为什么必须做成真正的画布节点（而不是之前的绝对定位覆盖层）：
 * 覆盖层是屏幕坐标，缩放不跟随、拖不动、端口被裁掉一半还点不到。
 * 做成节点后缩放/拖动/连线全交给画布，这三个问题一起消失。
 *
 * 关键约定：**左上角永远是 (posX, posY)**。
 * 展开时成员按各自相对它的偏移铺开，收起时又收回到它旁边 ——
 * 两种形态锚在同一点，开合时视觉上不会跳。
 */

export interface SgGroupData {
  groupId: string
  title: string
  color: string
  memberCount: number
  collapsed: boolean
  usedBy: number
  /** 拖线中的高亮态：与普通节点同一套语义 */
  connectHighlight?: 'origin' | 'compatible' | 'incompatible' | null
  /** 展开态的框尺寸（画布坐标，由成员的包围盒算出） */
  frameWidth: number
  frameHeight: number
  onToggle?: (groupId: string) => void
  onOpenMenu?: (groupId: string, clientX: number, clientY: number) => void
}

export function SgGroupNode({ data }: NodeProps) {
  const d = data as unknown as SgGroupData
  const color = d.color || '#6366f1'

  /**
   * 拖线高亮（用户 2026-11-24：「同时更新一下高亮的显示」）。
   *
   * 和普通节点用同一套语义，避免"有的亮、有的不亮"：
   *   compatible   组能接在当前拖线的落点上 → 绿色描边 + 外发光
   *   incompatible 接不上 → 压暗到 0.4，但仍可见
   *   origin       这根线就是从组拉出来的 → 保持不变
   */
  const highlight = d.connectHighlight ?? null
  const accent = highlight === 'compatible' ? '#22c55e' : highlight === 'origin' ? color : color
  const dimmed = highlight === 'incompatible'

  /* ── 收起：叠放卡片 ─────────────────────────────────────────────── */
  if (d.collapsed) {
    return (
      <div
        data-testid={`group-node-${d.groupId}`}
        data-collapsed="true"
        data-connect-highlight={highlight ?? undefined}
        style={{
          position: 'relative',
          width: 208,
          background: '#fff',
          borderRadius: 10,
          /**
           * 背后两层错位的边框 = "这里叠着东西"。
           * 比一个纯色方块更能说明里面不是空的。
           */
          boxShadow:
            highlight === 'compatible'
              ? `0 0 0 3px rgba(34,197,94,0.35), 3px 3px 0 -1px #fff, 3px 3px 0 0 ${color}66, 0 2px 8px rgba(15,23,42,0.12)`
              : `3px 3px 0 -1px #fff, 3px 3px 0 0 ${color}66, 6px 6px 0 -1px #fff, 6px 6px 0 0 ${color}33, 0 2px 8px rgba(15,23,42,0.12)`,
          border: `1.5px solid ${accent}`,
          opacity: dimmed ? 0.4 : 1,
          transition: 'box-shadow .12s, opacity .12s, border-color .12s',
          fontFamily: 'inherit',
          fontSize: 11,
          color,
          fontWeight: 600,
        }}
      >
        <Header d={d} color={color} collapsed />
        <div style={{ padding: '0 8px 7px', fontSize: 10, color: '#64748b', fontWeight: 400 }}>
          作为上下文：{d.memberCount} 个节点的产物
          {d.usedBy > 0 ? ` · 已被 ${d.usedBy} 个节点引用` : ''}
        </div>
        {/* 收起态也有出点：用户明确指出之前这里没有 */}
        <Handle
          id="group-out"
          type="source"
          position={Position.Right}
          title="拖到下游节点上：把这一组当作上下文"
          style={handleStyle(color)}
        />
      </div>
    )
  }

  /* ── 展开：虚线框 ───────────────────────────────────────────────── */
  return (
    <div
      data-testid={`group-node-${d.groupId}`}
      data-collapsed="false"
      onContextMenu={(event) => {
        // 在框上右键 = 组菜单（重命名/解组/按依赖运行…）
        event.preventDefault()
        event.stopPropagation()
        d.onOpenMenu?.(d.groupId, event.clientX, event.clientY)
      }}
      data-connect-highlight={highlight ?? undefined}
      style={{
        position: 'relative',
        width: d.frameWidth,
        height: d.frameHeight,
        // 能接上时描边转绿并加一圈内发光：虚线框本身很淡，只改颜色不够醒目
        border: highlight === 'compatible' ? '1.5px dashed #22c55e' : `1.5px dashed ${color}`,
        boxShadow: highlight === 'compatible' ? 'inset 0 0 0 3px rgba(34,197,94,0.12)' : undefined,
        opacity: dimmed ? 0.4 : 1,
        transition: 'border-color .12s, box-shadow .12s, opacity .12s',
        borderRadius: 10,
        /**
         * 框内部**不接收**鼠标事件：否则它会把成员的点击、框选、拖拽全吃掉
         * （这正是之前"框里节点点不动"的原因）。只有标题条和出点可点。
         */
        pointerEvents: 'none',
        background: 'transparent',
        fontFamily: 'inherit',
        fontSize: 11,
        color,
        fontWeight: 600,
      }}
    >
      {/* 左上角：开合按钮 + 名字。整条是拖拽手柄，拖它等于移动整个组 */}
      <div
        // 不能加 nodrag：这条就是拖动整个组的把手。
        // 但框本身 pointerEvents:none，所以右键要在这里接（框上的事件收不到）。
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          d.onOpenMenu?.(d.groupId, event.clientX, event.clientY)
        }}
        style={{
          position: 'absolute',
          top: -1,
          left: -1,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px 3px 5px',
          borderRadius: '10px 0 8px 0',
          background: `${color}12`,
          borderRight: `1px dashed ${color}`,
          borderBottom: `1px dashed ${color}`,
          pointerEvents: 'auto',
          cursor: 'grab',
          userSelect: 'none',
          maxWidth: 'calc(100% - 12px)',
        }}
      >
        <Header d={d} color={color} />
      </div>

      {/* 出点：贴在框的右侧边上 */}
      <Handle
        id="group-out"
        type="source"
        position={Position.Right}
        title="拖到下游节点上：把这一组当作上下文"
        style={{ ...handleStyle(color), pointerEvents: 'auto', right: -8, top: 22 }}
      />
    </div>
  )
}

function Header({ d, color, collapsed }: { d: SgGroupData; color: string; collapsed?: boolean }) {
  return (
    <>
      <button
        type="button"
        className="nodrag"
        data-testid={`toggle-group-${d.groupId}`}
        title={collapsed ? '展开这一组' : '收起这一组'}
        onClick={(event) => {
          event.stopPropagation()
          d.onToggle?.(d.groupId)
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          borderRadius: 6,
          border: `1px solid ${color}`,
          background: '#fff',
          color,
          cursor: 'pointer',
          fontSize: 11,
          lineHeight: 1,
          padding: 0,
          flexShrink: 0,
        }}
      >
        {collapsed ? '▸' : '▾'}
      </button>

      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
      <span style={{ color: '#94a3b8', fontWeight: 400, flexShrink: 0 }}>{d.memberCount} 个</span>

      <button
        type="button"
        className="nodrag"
        data-testid={`group-menu-${d.groupId}`}
        title="更多（重命名 / 解组 / 删除）"
        onClick={(event) => {
          event.stopPropagation()
          d.onOpenMenu?.(d.groupId, event.clientX, event.clientY)
        }}
        style={{ marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer', color: '#94a3b8', fontSize: 13, padding: '0 2px', lineHeight: 1, flexShrink: 0 }}
      >
        ⋯
      </button>
    </>
  )
}

const handleStyle = (color: string): React.CSSProperties => ({
  width: 14,
  height: 14,
  background: '#fff',
  border: `2px solid ${color}`,
  boxShadow: '0 1px 4px rgba(15,23,42,0.2)',
  cursor: 'crosshair',
})
