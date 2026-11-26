'use client'

import { MathText } from '../MathText'

import { useEffect, useState } from 'react'

/**
 * 建组对话框：**一次问完**名字和"要不要纳入相连节点"。
 *
 * 为什么不用「先 confirm 再 prompt」的两段式：
 * 两段式依赖两次独立的弹窗状态，第二次会把第一次的 Promise 覆盖掉，
 * 表现为"点完就没反应了"（用户报的「现在无法建组了」）。
 * 合成一个对话框后，只有一个 pending 状态，没有这种时序问题；
 * 而且用户也不用连着点两次确认。
 */

export interface GroupCreateDialogProps {
  /** 参与成组的节点数（已选中的） */
  memberCount: number
  /** 组外相连节点的标题（为空表示没有跨组连线，不显示那一块） */
  outside: string[]
  onCancel: () => void
  onConfirm: (result: { title: string; includeOutside: boolean }) => void
}

export function GroupCreateDialog({ memberCount, outside, onCancel, onConfirm }: GroupCreateDialogProps) {
  const [title, setTitle] = useState('上下文组')
  /**
   * 有跨组连线时默认勾选"一并纳入"：
   * 不纳如的话那条线在收起后就看不见了，绝大多数情况下用户想要的是闭合的组。
   */
  const [includeOutside, setIncludeOutside] = useState(outside.length > 0)

  const total = includeOutside ? memberCount + outside.length : memberCount
  const trimmed = title.trim()
  const canSubmit = trimmed.length > 0 && total >= 2

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      data-testid="group-create-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'grid', placeItems: 'center', zIndex: 400 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{ background: '#fff', borderRadius: 12, padding: 20, width: 430, maxWidth: 'calc(100vw - 32px)', boxShadow: '0 20px 50px rgba(15,23,42,0.25)' }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 6px' }}>打包成组</h2>
        <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 10px' }}>
          已选 {memberCount} 个节点。组的左上角会定在所选节点的左上侧。
        </p>

        <label style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 4 }}>组名</label>
        <input
          autoFocus
          data-testid="group-create-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canSubmit) onConfirm({ title: trimmed, includeOutside })
          }}
          style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 8, padding: '8px 10px', fontSize: 13, marginBottom: 14 }}
        />

        {outside.length > 0 ? (
          <div
            data-testid="group-create-outside"
            style={{ border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 8, padding: '9px 11px', marginBottom: 16 }}
          >
            <p style={{ fontSize: 12, color: '#92400e', margin: '0 0 7px', lineHeight: 1.6 }}>
              这些节点和组外有连线：<MathText>{outside.slice(0, 5).join('、')}</MathText>
              {outside.length > 5 ? ` 等 ${outside.length} 个` : ''}。
              <br />
              不纳入的话，收起后这些连线会"看不见但还在"，上下游关系会变得难理解。
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#78350f', cursor: 'pointer' }}>
              <input
                type="checkbox"
                data-testid="group-create-include-outside"
                checked={includeOutside}
                onChange={(event) => setIncludeOutside(event.target.checked)}
              />
              一并纳入相连的 {outside.length} 个节点（共 {memberCount + outside.length} 个）
            </label>
          </div>
        ) : (
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 16px' }}>
            这些节点与组外没有连线，建出来是一个封闭的组。
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            data-testid="group-create-cancel"
            onClick={onCancel}
            style={{ border: '1px solid #e2e8f0', background: '#fff', color: '#475569', borderRadius: 8, padding: '7px 14px', fontSize: 13, cursor: 'pointer' }}
          >
            取消
          </button>
          <button
            type="button"
            data-testid="group-create-confirm"
            disabled={!canSubmit}
            onClick={() => onConfirm({ title: trimmed, includeOutside })}
            style={{
              border: 'none',
              background: canSubmit ? '#2563eb' : '#93c5fd',
              color: '#fff',
              borderRadius: 8,
              padding: '7px 16px',
              fontSize: 13,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            打包 {total} 个节点
          </button>
        </div>
      </div>
    </div>
  )
}
