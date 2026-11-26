import type { Metadata } from 'next'

import 'katex/dist/katex.min.css'
import './globals.css'

export const metadata: Metadata = {
  title: 'StudyGraph',
  description: '节点式 AI 学习工作流平台',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
