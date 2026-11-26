'use client'

import { MathText } from '../MathText'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 应用内输入 / 确认对话框。
 *
 * **为什么不能用 `window.prompt`**：Electron 的渲染进程**没有实现** `prompt()`，
 * 调用直接返回 `null`，不报错、不弹窗。所以「重命名」这类功能在网页里能用、
 * 装成桌面端之后就变成"点了没反应" —— 用户报的就是这个。
 *
 * `alert()` / `confirm()` 在 Electron 里能用，但样式是系统框、会阻塞渲染，
 * 和产品界面完全不搭。这里统一用同一套弹窗，行为在浏览器和桌面端一致。
 *
 * 用法（命令式，和 prompt 一样顺手）：
 *   const { prompt, confirm, dialog } = usePrompt()
 *   ...
 *   const title = await prompt({ title: '重命名画布', defaultValue: current?.title })
 *   if (title === null) return          // 用户取消
 *   if (await confirm({ message: '删除？' })) { ... }
 *   {dialog}                            // 渲染在组件里的任意位置
 */

interface PromptOptions {
  title: string
  description?: string
  defaultValue?: string
  placeholder?: string
  /** 确定按钮文案，默认「确定」 */
  okText?: string
  /** 空值是否允许提交，默认不允许 */
  allowEmpty?: boolean
}

interface ConfirmOptions {
  title: string
  message: string
  okText?: string
  danger?: boolean
}

type State =
  | { kind: 'prompt'; options: PromptOptions; value: string; resolve: (value: string | null) => void }
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }

export function usePrompt() {
  const [state, setState] = useState<State | null>(null)
  /** 未结算的 resolver：组件卸载时给它一个"取消"，避免 await 永远挂住 */
  const pending = useRef<State | null>(null)

  useEffect(() => {
    pending.current = state
  }, [state])

  useEffect(
    () => () => {
      const waiting = pending.current
      if (!waiting) return
      if (waiting.kind === 'prompt') waiting.resolve(null)
      else waiting.resolve(false)
    },
    [],
  )

  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setState({ kind: 'prompt', options, value: options.defaultValue ?? '', resolve })
      }),
    [],
  )

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ kind: 'confirm', options, resolve })
      }),
    [],
  )

  const close = useCallback((result: string | null | boolean) => {
    setState((current) => {
      if (!current) return null
      if (current.kind === 'prompt') current.resolve(typeof result === 'string' ? result : null)
      else current.resolve(result === true)
      return null
    })
  }, [])

  const dialog = state ? (
    <PromptModal state={state} onClose={close} onValue={(value) => setState((current) => (current && current.kind === 'prompt' ? { ...current, value } : current))} />
  ) : null

  return { prompt, confirm, dialog }
}

function PromptModal({
  state,
  onClose,
  onValue,
}: {
  state: State
  onClose: (result: string | null | boolean) => void
  onValue: (value: string) => void
}) {
  const options = state.options
  const isPrompt = state.kind === 'prompt'
  const value = state.kind === 'prompt' ? state.value : ''
  const trimmed = value.trim()
  // 联合类型不能让 TS 直接看到 allowEmpty，这里按分支取
  const canSubmit = state.kind === 'prompt' ? state.options.allowEmpty === true || trimmed.length > 0 : true

  const submit = () => {
    if (!canSubmit) return
    onClose(isPrompt ? trimmed : true)
  }

  return (
    <div
      data-testid="prompt-dialog"
      // 点遮罩取消（和系统 prompt 的 Esc 行为一致）
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose(isPrompt ? null : false)
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.4)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 400,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose(isPrompt ? null : false)
        }}
        style={{
          background: '#fff',
          borderRadius: 12,
          padding: 20,
          width: 400,
          maxWidth: 'calc(100vw - 32px)',
          boxShadow: '0 20px 50px rgba(15,23,42,0.25)',
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 6px' }}>{options.title}</h2>
        {state.kind === 'confirm' ? (
          <p style={{ fontSize: 13, color: '#475569', margin: '0 0 16px', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
            <MathText>{state.options.message}</MathText>
          </p>
        ) : (
          <>
            {state.options.description && (
              <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 8px' }}><MathText>{state.options.description}</MathText></p>
            )}
            <input
              autoFocus
              data-testid="prompt-dialog-input"
              value={value}
              placeholder={state.options.placeholder}
              onChange={(event) => onValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submit()
                }
              }}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                border: '1px solid #cbd5e1',
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 13,
                marginBottom: 16,
              }}
            />
          </>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" data-testid="prompt-dialog-cancel" onClick={() => onClose(isPrompt ? null : false)} style={cancelStyle}>
            取消
          </button>
          <button
            type="button"
            data-testid="prompt-dialog-ok"
            autoFocus={!isPrompt}
            disabled={!canSubmit}
            onClick={submit}
            style={{
              ...okStyle,
              background: !canSubmit ? '#93c5fd' : state.kind === 'confirm' && state.options.danger ? '#dc2626' : '#2563eb',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            {(options.okText ?? (isPrompt ? '确定' : '删除'))}
          </button>
        </div>
      </div>
    </div>
  )
}

const cancelStyle: React.CSSProperties = {
  border: '1px solid #e2e8f0',
  background: '#fff',
  color: '#475569',
  borderRadius: 8,
  padding: '7px 14px',
  fontSize: 13,
  cursor: 'pointer',
}

const okStyle: React.CSSProperties = {
  border: 'none',
  color: '#fff',
  borderRadius: 8,
  padding: '7px 16px',
  fontSize: 13,
}
