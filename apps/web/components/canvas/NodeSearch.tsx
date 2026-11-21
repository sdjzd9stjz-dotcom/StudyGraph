'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import type { NodeType } from '../../../../packages/contracts/src/client'
import { ADVANCED_NODES, PRIMARY_NODES } from '../../lib/canvas-meta'

export interface NodeSearchProps {
  /** 屏幕坐标（定位浮层） */
  x: number
  y: number
  /** 只允许这些类型（端口拖拽建节点时按端口类型过滤）；不传则全部可选 */
  allowed?: Set<NodeType> | undefined
  /** 浮层标题，说明为什么只能选这些 */
  reason?: string | undefined
  onPick: (type: NodeType) => void
  onClose: () => void
}

/** 两种来源的字段不一样（PRIMARY 有 color），统一成同一形状再用 */
const ALL: Array<{ type: NodeType; label: string; hint: string; color: string }> = [
  ...PRIMARY_NODES,
  ...ADVANCED_NODES.map((node) => ({ ...node, color: '#94a3b8' })),
]

/**
 * 节点搜索面板（照 ComfyUI 的双击搜索）。
 *
 * 两处复用：
 *   · 画布空白处双击 → 全部类型
 *   · 从端口拖到空白处松手 → **只列出能连上的类型**，选中后自动接线
 *
 * 键盘：↑↓ 选择、Enter 确认、Esc 关闭。ComfyUI 里这套操作快得可以盲打，
 * 所以输入框要自动聚焦，且首项默认选中。
 */
export function NodeSearch({ x, y, allowed, reason, onPick, onClose }: NodeSearchProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const options = useMemo(() => {
    const pool = allowed ? ALL.filter((node) => allowed.has(node.type)) : ALL
    const keyword = query.trim().toLowerCase()
    if (!keyword) return pool
    return pool.filter((node) => {
      const haystack = `${node.label}${node.type}${node.hint}`.toLowerCase()
      return haystack.includes(keyword)
    })
  }, [allowed, query])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setActive(0)
  }, [query])

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,0.06)' }} />
      <div
        data-testid="node-search"
        style={{
          position: 'fixed',
          left: x,
          top: y,
          zIndex: 61,
          width: 296,
          background: '#fff',
          border: '1px solid #e2e8f0',
          borderRadius: 10,
          boxShadow: '0 16px 40px rgba(15,23,42,0.18)',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          data-testid="node-search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActive((index) => Math.min(index + 1, options.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((index) => Math.max(index - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              const picked = options[active]
              if (picked) onPick(picked.type)
            }
          }}
          placeholder={reason ? `${reason}…` : '搜索节点（课件、概念、知识卡…）'}
          style={{ width: '100%', border: 'none', borderBottom: '1px solid #f1f5f9', padding: '10px 12px', fontSize: 13, outline: 'none' }}
        />

        <div style={{ maxHeight: 296, overflowY: 'auto', padding: 4 }}>
          {options.length === 0 && (
            <div style={{ padding: '10px 12px', fontSize: 12, color: '#94a3b8' }}>
              {allowed ? '这个端口没有能接上的节点类型' : '没有匹配的节点'}
            </div>
          )}
          {options.map((node, index) => (
            <button
              key={node.type}
              type="button"
              data-testid={`search-option-${node.type}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => onPick(node.type)}
              style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                textAlign: 'left',
                gap: 8,
                padding: '6px 8px',
                border: 'none',
                borderRadius: 6,
                background: index === active ? '#eff6ff' : 'transparent',
                cursor: 'pointer',
                fontSize: 12,
                color: '#1f2937',
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: 99, background: node.color, flexShrink: 0 }} />
              <span style={{ fontWeight: 600 }}>{node.label}</span>
              <span style={{ color: '#94a3b8', fontSize: 11, marginLeft: 'auto' }}>{node.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
