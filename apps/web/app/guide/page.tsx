import Link from 'next/link'

import { guideToHtml, loadGuide } from '../../lib/guide'

export const dynamic = 'force-dynamic'

/**
 * 应用内使用教程。
 *
 * 用户要求「将整个说明教程植入到应用界面里面，用来快速告诉用户如何使用」。
 * 内容直接读 docs/使用说明书.md（见 lib/guide.ts 的说明：抄一份就会分叉），
 * 所以改说明书 = 改应用里的教程，不需要两处维护。
 */
export default function GuidePage() {
  const { markdown, source } = loadGuide()
  const html = guideToHtml(markdown)

  return (
    <main style={{ padding: '24px 32px 48px', maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>使用教程</h1>
        <Link href="/" data-testid="guide-home" style={{ color: '#2563eb', fontSize: 13, marginLeft: 'auto' }}>← 返回画布列表</Link>
        <Link href="/settings" style={{ color: '#2563eb', fontSize: 13 }}>
          模型供应商
        </Link>
      </div>

      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 18 }}>
        这页就是随软件附带的《使用说明书》，跟着做一遍就能把课件变成知识卡、能复习、能刷题。
      </p>

      {source === null && (
        <div
          data-testid="guide-missing"
          style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', borderRadius: 8, padding: '8px 12px', fontSize: 12, marginBottom: 16 }}
        >
          没有找到说明书原文件，下面显示的是内置的精简版。
        </div>
      )}

      <article
        data-testid="guide-content"
        style={{ fontSize: 13.5, lineHeight: 1.85, color: '#1f2937' }}
        dangerouslySetInnerHTML={{ __html: `<style>${GUIDE_CSS}</style>${html}` }}
      />
    </main>
  )
}

/** 教程正文样式。写在这里而不是 globals.css：只影响这一页。 */
const GUIDE_CSS = `
.guide-scope h2 { font-size: 18px; margin: 26px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e2e8f0; }
.guide-scope h3 { font-size: 15px; margin: 20px 0 8px; }
.guide-scope p { margin: 8px 0; }
.guide-scope ul, .guide-scope ol { margin: 8px 0 8px 22px; padding: 0; }
.guide-scope li { margin: 4px 0; }
.guide-scope table { border-collapse: collapse; width: 100%; margin: 12px 0 16px; font-size: 12.5px; }
.guide-scope th, .guide-scope td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; vertical-align: top; }
.guide-scope th { background: #f1f5f9; font-weight: 600; }
.guide-scope code { font-family: Consolas, 'Courier New', monospace; background: #f1f5f9; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.guide-scope pre { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px 14px; overflow-x: auto; }
.guide-scope pre code { background: transparent; padding: 0; }
.guide-scope blockquote { margin: 12px 0; padding: 8px 14px; border-left: 3px solid #94a3b8; background: #f8fafc; color: #475569; }
.guide-scope hr { border: none; border-top: 1px solid #e2e8f0; margin: 22px 0; }
.guide-scope .link { color: #2563eb; }
`
