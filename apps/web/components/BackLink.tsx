'use client'

import Link from 'next/link'

/**
 * 「返回<上一界面名>」。
 *
 * 用户要求显示具体名字，而不是笼统的「返回」：只写"返回"时，
 * 用户不知道会退到哪 —— 在画布、题库、复习之间来回切时尤其明显。
 *
 * 名字由调用方给定（服务端组件知道当前上下文，客户端不知道）。
 * 不用 router.back()：浏览器历史里可能是一个外站或表单提交后的中间态，
 * 显式链接永远落到确定的地方。
 */
export function BackLink({ href, label, testId }: { href: string; label: string; testId?: string }) {
  return (
    <Link
      href={href}
      data-testid={testId ?? 'back-link'}
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
      }}
    >
      ← 返回{label}
    </Link>
  )
}
