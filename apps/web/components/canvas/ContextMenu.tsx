'use client'

import { useState } from 'react'

import type { NodeType } from '../../../../packages/contracts/src/client'
import { ADVANCED_NODES, PRIMARY_NODES } from '../../lib/canvas-meta'

export interface MenuContext {
  /** 屏幕坐标 */
  x: number
  y: number
  /** 右键点在哪：空白处还是某个节点上 */
  nodeId: string | null
  /** 转换为画布坐标后的落点 */
  flowX: number
  flowY: number
}

/**
 * 右键菜单（照 ComfyUI 的做法）。
 *
 * 两个必须有：
 *   · 空白处右键 → 「新建节点」**悬停展开**类型子菜单（用户明确要求）
 *   · 节点上右键 → 重命名 / 复制 / 删除
 *
 * 子菜单用 CSS hover 而不是 JS 状态：JS 状态在鼠标斜向移动时容易"闪断"，
 * ComfyUI 也是靠一层不可见的连接区把 hover 接住。
 */
export function ContextMenu({
  menu,
  onClose,
  onCreateNode,
  onRename,
  onDelete,
  onDuplicate,
  onRun,
  selectedCount,
  onPackGroup,
  onSplitCards,
  nodeType,
}: {
  menu: MenuContext
  onClose: () => void
  onCreateNode: (type: NodeType, x: number, y: number) => void
  onRename: (nodeId: string) => void
  onDelete: (nodeId: string) => void
  onDuplicate: (nodeId: string) => void
  onRun: (nodeId: string) => void
  selectedCount: number
  onPackGroup: () => void
  /** 按概念拆分知识卡（只有概念抽取节点有这一项） */
  onSplitCards?: (nodeId: string) => void
  /** 右键点中的节点类型：决定菜单里显示哪些专属项 */
  nodeType?: string | null
}) {
  const [subOpen, setSubOpen] = useState(false)

  return (
    <>
      {/* 点击任意处关闭 */}
      <div onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />

      <div
        data-testid="context-menu"
        style={{
          position: 'fixed',
          left: menu.x,
          top: menu.y,
          zIndex: 50,
          minWidth: 176,
          background: '#fff',
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          boxShadow: '0 10px 28px rgba(15,23,42,0.16)',
          padding: 4,
          fontSize: 13,
        }}
      >
        {menu.nodeId ? (
          <>
            <Item label="运行此节点" onClick={() => { onRun(menu.nodeId!); onClose() }} />
            {/*
              按概念拆分：只对概念抽取节点显示。
              之前这个能力只有对话和接口能触发，界面上找不到入口 ——
              用户只能手工建卡，结果每张卡内容都一样（真实报障）。
            */}
            {nodeType === 'EXTRACT' && onSplitCards && (
              <Item
                label="按概念拆成知识卡"
                testId="menu-split-cards"
                onClick={() => { onSplitCards(menu.nodeId!); onClose() }}
              />
            )}
            <Item label="重命名" onClick={() => { onRename(menu.nodeId!); onClose() }} />
            <Item label="复制节点" onClick={() => { onDuplicate(menu.nodeId!); onClose() }} />
            <Divider />
            {selectedCount >= 2 && <Item label={`打包这 ${selectedCount} 个节点为上下文`} onClick={() => { onPackGroup(); onClose() }} />}
            <Item label="删除" danger onClick={() => { onDelete(menu.nodeId!); onClose() }} />
          </>
        ) : (
          <>
            <div
              data-testid="menu-new-node"
              onMouseEnter={() => setSubOpen(true)}
              style={{ display: 'flex', alignItems: 'center', padding: '7px 10px', borderRadius: 6, cursor: 'default', background: subOpen ? '#f1f5f9' : 'transparent' }}
            >
              新建节点
              <span style={{ marginLeft: 'auto', color: '#94a3b8' }}>▸</span>
            </div>

            {subOpen && (
              <div
                data-testid="menu-node-types"
                onMouseEnter={() => setSubOpen(true)}
                style={{
                  position: 'absolute',
                  left: '100%',
                  top: 0,
                  marginLeft: 4,
                  background: '#fff',
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  boxShadow: '0 10px 28px rgba(15,23,42,0.16)',
                  padding: 4,
                  minWidth: 214,
                  maxHeight: 340,
                  overflowY: 'auto',
                }}
              >
                <div style={sectionLabel}>常用</div>
                {PRIMARY_NODES.map((node) => (
                  <button
                    key={node.type}
                    type="button"
                    data-testid={`create-${node.type}`}
                    onClick={() => { onCreateNode(node.type, menu.flowX, menu.flowY); onClose() }}
                    style={subItem}
                    onMouseEnter={(event) => { event.currentTarget.style.background = '#f1f5f9' }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent' }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: 99, background: node.color, display: 'inline-block', marginRight: 8 }} />
                    <span style={{ fontWeight: 600 }}>{node.label}</span>
                    <span style={{ color: '#94a3b8', marginLeft: 8, fontSize: 11 }}>{node.hint}</span>
                  </button>
                ))}
                <div style={sectionLabel}>高级</div>
                {ADVANCED_NODES.map((node) => (
                  <button
                    key={node.type}
                    type="button"
                    data-testid={`create-${node.type}`}
                    onClick={() => { onCreateNode(node.type, menu.flowX, menu.flowY); onClose() }}
                    style={subItem}
                    onMouseEnter={(event) => { event.currentTarget.style.background = '#f1f5f9' }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent' }}
                  >
                    <span style={{ fontWeight: 500 }}>{node.label}</span>
                    <span style={{ color: '#94a3b8', marginLeft: 8, fontSize: 11 }}>{node.hint}</span>
                  </button>
                ))}
              </div>
            )}

            <Divider />
            {selectedCount >= 2 && <Item label={`打包选中的 ${selectedCount} 个节点`} onClick={() => { onPackGroup(); onClose() }} />}
            <Item label="粘贴" disabled onClick={() => {}} />
          </>
        )}
      </div>
    </>
  )
}

function Item({
  label,
  onClick,
  danger,
  disabled,
  testId,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '7px 10px',
        border: 'none',
        background: 'transparent',
        borderRadius: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? '#cbd5e1' : danger ? '#dc2626' : '#1f2937',
        fontSize: 13,
      }}
      onMouseEnter={(event) => { if (!disabled) event.currentTarget.style.background = '#f1f5f9' }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent' }}
    >
      {label}
    </button>
  )
}

const Divider = () => <div style={{ height: 1, background: '#f1f5f9', margin: '4px 2px' }} />

const sectionLabel: React.CSSProperties = { fontSize: 10, color: '#94a3b8', padding: '4px 10px' }

const subItem: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  textAlign: 'left',
  padding: '6px 10px',
  border: 'none',
  background: 'transparent',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12,
  color: '#1f2937',
}
