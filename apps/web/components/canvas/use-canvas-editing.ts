'use client'

import { useEffect, useRef, useState } from 'react'

export type DeleteTargets = {
  nodes?: string[]; groups?: string[]; edges?: string[]; links?: { groupId: string; nodeId: string }[]
}

export function useCanvasEditing(options: { api: string; canvasId: string; token: string; beforeEdit: () => Promise<void>; sync: () => Promise<void>; notify: (s: string) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const busy = useRef(false)
  const [pending,setPending] = useState(false)
  const [history,setHistory] = useState<{undo:string|null;redo:string|null}|null>(null)
  const revision = useRef(0)
  useEffect(() => {
    const ctrl = new AbortController(), current = revision.current
    fetch(`${options.api}/v1/canvases/${options.canvasId}/edits`, {signal:ctrl.signal, headers:{authorization:`Bearer ${options.token}`}, cache:'no-store'})
      .then(async r => { if(r.ok){const h=await r.json(); if(!ctrl.signal.aborted && revision.current===current)setHistory(h)} }).catch(()=>{})
    return () => ctrl.abort()
  }, [options.api,options.canvasId,options.token])
  async function edit(mode: 'delete' | 'undo' | 'redo', targets: DeleteTargets = {}) {
    if (busy.current) return
    busy.current = true
    setPending(true)
    try {
      await options.beforeEdit()
      const response = await fetch(`${options.api}/v1/canvases/${options.canvasId}/edits/${mode}`, {
        method: 'POST', headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' }, body: JSON.stringify(targets),
      })
      const body = await response.json()
      if (!response.ok) throw Error(body.error?.message ?? `HTTP ${response.status}`)
      revision.current++; setHistory(body.history)
      if (!body.unchanged) {
        try { await options.sync() } catch { throw Error(`${body.message}；画布读取失败，请刷新。不要重复提交。`) }
        setSelected(new Set())
      }
      options.notify(body.message)
    } catch (error) { options.notify(error instanceof Error ? error.message : '操作未完成，请检查连接') }
    finally { busy.current = false; setPending(false) }
  }
  return { selected, setSelected, edit, history, pending }
}
