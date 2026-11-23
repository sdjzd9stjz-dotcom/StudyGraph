'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

import { previousEntry, recordVisit } from '../lib/nav-trail'

/**
 * 「← 返回<上一界面名字>」。
 *
 * 用户要求显示**具体名字**，而不是笼统的「返回」：只写"返回"时，
 * 用户不知道会退到哪 —— 在画布、题库、复习之间来回切时尤其明显。
 *
 * 名字从哪来：每次进页面时记一条 {path, label}（见 lib/nav-trail.ts），
 * 返回链接取"上一条"。所以从画布点进题库，题库的返回就是「← 返回 高数 第三章」，
 * 点回去确实回到那块画布 —— 而不是像以前那样写死回首页。
 *
 * 为什么不用 router.back()：历史里可能是外站或中间态；直接打开链接进来时
 * back 会退出应用。显式 href 永远落到确定的地方。
 *
 * fallback：没有轨迹（首次进入、直接打开链接）时退到首页。
 */
export function BackLink({
  label,
  fallbackHref = '/',
  fallbackLabel = '全部画布',
  testId = 'back-link',
}: {
  /** 当前页面的名字，用于写入轨迹（供下一页显示"返回 xxx"） */
  label: string
  /** 没有上一页时去哪 */
  fallbackHref?: string
  fallbackLabel?: string
  testId?: string
}) {
  const pathname = usePathname()
  const [previous, setPrevious] = useState<{ href: string; label: string } | null>(null)

  useEffect(() => {
    recordVisit({ path: pathname, label })
  }, [pathname, label])

  useEffect(() => {
    const entry = previousEntry(pathname)
    setPrevious(entry ? { href: entry.path, label: entry.label } : null)
  }, [pathname])

  const href = previous?.href ?? fallbackHref
  const text = previous?.label ?? fallbackLabel

  return (
    <Link
      href={href}
      data-testid={testId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        color: '#475569',
        fontSize: 13,
        textDecoration: 'none',
        border: '1px solid #e2e8f0',
        borderRadius: 7,
        padding: '4px 10px',
        background: '#fff',
        maxWidth: 260,
      }}
    >
      ← 返回 {text}
    </Link>
  )
}
