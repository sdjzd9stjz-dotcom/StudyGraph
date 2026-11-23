'use client'

import { useEffect, useState } from 'react'

/**
 * 「正在思考」气泡（用户 2026-11-23 要求：对话后要给出充分反馈）。
 *
 * 模型一次推理可能十几秒，这期间如果界面只是按钮变灰，用户不知道它在跑还是卡住。
 * 这里做三件事：
 *   1. 明确写"正在思考"，并用省略号动画表示仍在进行
 *   2. 分期显示阶段（读取画布 → 思考 → 组织回答），让等待有进度感
 *   3. 有思考摘要（模型 reasoning_content 的节选）就折叠着显示，可以点开看
 *
 * 为什么思考摘要默认折叠： оно 往往很长，展开会把对话挤走；
 * 但它对"这轮 AI 是不是跑偏了"很有诊断价值，所以给一个可展开的入口。
 */
const STAGES = ['正在读取画布内容', '正在思考', '正在组织回答']

export function ThinkingBubble({ thinking, stage }: { thinking?: string | null; stage?: string | null }) {
  const [tick, setTick] = useState(0)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1200)
    return () => window.clearInterval(timer)
  }, [])

  const currentStage = stage ?? STAGES[Math.min(tick, STAGES.length - 1)]!
  const dots = '.'.repeat((tick % 3) + 1)

  return (
    <div
      data-testid="thinking-bubble"
      style={{
        justifySelf: 'start',
        maxWidth: '92%',
        background: '#f8fafc',
        border: '1px dashed #cbd5e1',
        borderRadius: 10,
        padding: '7px 11px',
        fontSize: 12,
        color: '#64748b',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#6366f1',
            animation: 'sg-pulse 1.2s ease-in-out infinite',
            display: 'inline-block',
          }}
        />
        <span>
          {currentStage}
          {dots}
        </span>
        {thinking && (
          <button
            type="button"
            data-testid="toggle-thinking"
            onClick={() => setOpen((value) => !value)}
            style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: '#6366f1', fontSize: 11, cursor: 'pointer' }}
          >
            {open ? '收起思考' : '看思考过程'}
          </button>
        )}
      </div>

      {open && thinking && (
        <div
          data-testid="thinking-detail"
          style={{
            marginTop: 6,
            paddingTop: 6,
            borderTop: '1px dashed #e2e8f0',
            color: '#475569',
            lineHeight: 1.65,
            whiteSpace: 'pre-wrap',
            maxHeight: 160,
            overflowY: 'auto',
            fontSize: 11,
          }}
        >
          {thinking}
        </div>
      )}

      <style>{'@keyframes sg-pulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}'}</style>
    </div>
  )
}
