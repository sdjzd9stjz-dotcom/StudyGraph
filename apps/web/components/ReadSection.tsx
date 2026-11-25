'use client'

import { useEffect, useRef, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'

export function ReadSection({ error, children }: { error?: string; children?: ReactNode }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const last = useRef<ReactNode>(null)
  useEffect(() => { if (!error) last.current = children }, [error, children])
  return <>{error && <div role="alert" style={{padding: 10, color:'#92400e',background:'#fffbeb'}}>{error}未能读取。 <button type="button" disabled={pending} onClick={() => start(() => router.refresh())}>{pending ? '正在重试…' : '重试'}</button></div>}{error ? last.current : children}</>
}
