'use client'

import { useEffect, useRef, useState } from 'react'

type Step = { label: string; run: () => Promise<unknown> }
type ExitWindow = Window & { studyGraphLeave?: () => Promise<boolean> }

export function useCanvasExit(steps: Step[], fallback: () => void) {
  const latest = useRef({ steps, fallback }); latest.current = { steps, fallback }
  const [state, setState] = useState<{ labels: string[]; index: number; error?: string } | null>(null)
  const decision = useRef<(choice: 'retry' | 'stay' | 'discard') => void>()
  const active = useRef<Promise<boolean> | null>(null)
  const modal = useRef<HTMLDialogElement>(null)
  const visible = !!state
  useEffect(() => { if (visible && !modal.current?.open) modal.current?.showModal() }, [visible])
  useEffect(() => {
    const win = window as ExitWindow
    let leaving = false
    const request = () => {
      if (active.current) return active.current
      const run = async () => {
        const tasks = latest.current.steps, labels = tasks.map(s => s.label)
        setState({labels,index:0})
        if (document.visibilityState === 'visible') await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        for (let index = 0; index < tasks.length;) {
          setState({ labels, index })
          try { await tasks[index]!.run(); index++ } catch (e) {
            setState({ labels, index, error: e instanceof Error ? e.message : String(e) })
            const choice = await new Promise<'retry' | 'stay' | 'discard'>(r => { decision.current = r })
            if (choice !== 'retry') return choice === 'discard'
          }
        }
        return true
      }
      active.current = run().then(ok => { leaving = ok; return ok }).finally(() => { active.current = null; setState(null) })
      return active.current
    }
    win.studyGraphLeave = request
    const click = (e: MouseEvent) => {
      const a = (e.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || e.button || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || a.target === '_blank' || a.hasAttribute('download') || a.origin !== location.origin || a.pathname === location.pathname) return
      e.preventDefault(); e.stopImmediatePropagation()
      if (!active.current) void request().then(ok => { if (ok) location.assign(a.href) })
    }
    const hide = () => { if (!leaving) latest.current.fallback() }
    document.addEventListener('click', click, true); window.addEventListener('pagehide', hide)
    return () => { delete win.studyGraphLeave; document.removeEventListener('click', click, true); window.removeEventListener('pagehide', hide) }
  }, [])
  return state && <dialog ref={modal} onCancel={e => e.preventDefault()} aria-label="保存画布" data-testid="exit-progress" style={{border:0,padding:0,borderRadius:8,margin:'auto'}} onKeyDown={e => e.stopPropagation()}>
    <section style={{background:'white', padding:24, borderRadius:8, minWidth:280}}><h2>正在保存画布</h2>
      {state.labels.map((s,i) => <p key={s}>{i < state.index ? '已完成' : i === state.index ? (state.error ? '失败' : '确认中') : '等待'} · {s}</p>)}
      {state.error && <><p role="alert">{state.error}</p><button autoFocus onClick={() => decision.current?.('retry')}>重试保存</button> <button onClick={() => decision.current?.('stay')}>留在画布</button> <button onClick={() => decision.current?.('discard')}>放弃未保存内容并退出</button></>}
    </section></dialog>
}
