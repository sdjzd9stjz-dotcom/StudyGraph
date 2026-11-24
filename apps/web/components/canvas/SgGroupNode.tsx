'use client'

import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'

/**
 * 画布上的"组"节点。
 *
 * 为什么把组做成真正的节点（而不是之前那个绝对定位的覆盖层）：
 * 覆盖层是屏幕坐标，缩放时要自己换算，还压住了节点、挡掉了点击
 * （用户实测：收起后不跟随缩放、拖不动、右侧输出点点不到）。
 * 做成节点之后，缩放、拖动、连接线三件事全部由画布统一处理，不用再各写一遍。
 *
 * 展开时它只当"标题条"用，虚线框是它背后的装饰层；收起时它就是那个叠放的卡片。
 */

export interface SgGroupData {
  groupId: string
  title: string
  color: string
  memberCount: number
  collapsed: boolean
  usedBy: number
  onToggle?: (groupId: string) => void
  onOpenMenu?: (groupId: string, clientX: number, clientY: number) => void
}

export function SgGroupNode({ data }: NodeProps) {
  const d = data as unknown as SgGroupData
  const color = d.color || '#6366f1'

  return (
    <div
      data-testid={`group-node-${d.groupId}`}
      data-collapsed={d.collapsed ? 'true' : 'false'}
      style={{
        position: 'relative',
        width: d.collapsed ? 208 : 232,
        background: '#fff',
        borderRadius: 10,
        /**
         * 收起态画成"一叠卡片"：背后两层错位的边框暗示里面还有东西，
         * 比一个纯色方块更能说明"这里叠着 N 个节点"。
         */
        boxShadow: d.collapsed
          ? `3px 3px 0 -1px #fff, 3px 3px 0 0 ${color}66, 6px 6px 0 -1px #fff, 6px 6px 0 0 ${color}33, 0 2px 8px rgba(15,23,42,0.12)`
          : '0 1px 3px rgba(15,23,42,0.1)',
        border: `1.5px dashed ${color}`,
        fontFamily: 'inherit',
        fontSize: 11,
        color,
        fontWeight: 600,
        transition: 'width 180ms ease, box-shadow 180ms ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', background: d.collapsed ? `${color}12` : 'transparent', borderRadius: 9 }}>
        {/* 左上角快捷开合：20px 圆角块，缩放到 60% 也点得中 */}
        <button
          type="button"
          className="nodrag"
          data-testid={`toggle-group-${d.groupId}`}
          title={d.collapsed ? '展开这一组' : '收起这一组'}
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
          {d.collapsed ? '▸' : '▾'}
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
      </div>

      {d.collapsed && (
        <div style={{ padding: '0 8px 7px', fontSize: 10, color: '#64748b', fontWeight: 400 }}>
          作为上下文：{d.memberCount} 个节点的产物
          {d.usedBy > 0 ? ` · 已被 ${d.usedBy} 个节点引用` : ''}
        </div>
      )}

      {/*
        输出端口：真实的 Handle，由画布负责拖线与落点判定。
        之前是覆盖层上手画的圆点，一半被裁掉、也点不到 —— 换成 Handle 后
        位置、命中区、连线预览都是画布的标准行为。
      */}
      <Handle
        id="group-out"
        type="source"
        position={Position.Right}
        title="拖到下游节点上：把这一组当作上下文"
        style={{
          width: 14,
          height: 14,
          right: -8,
          background: '#fff',
          border: `2px solid ${color}`,
          boxShadow: '0 1px 4px rgba(15,23,42,0.2)',
          cursor: 'crosshair',
        }}
      />
    </div>
  )
}
