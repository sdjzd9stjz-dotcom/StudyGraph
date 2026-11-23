import Link from 'next/link'

import { fetchErrorCatalog, fetchErrorTags } from '../../lib/api'

export const dynamic = 'force-dynamic'

const CATEGORY_LABEL: Record<string, string> = {
  CONCEPT_GAP: '概念没懂',
  METHOD_MISMATCH: '用错方法',
  CONDITION_MISSED: '漏条件',
  COMPUTE_SLIP: '算错',
  READING_SLIP: '看错题',
  CHECK_OMITTED: '没检查',
  UNKNOWN: '未归类',
}

const CATEGORY_COLOR: Record<string, string> = {
  CONCEPT_GAP: '#dc2626',
  METHOD_MISMATCH: '#ea580c',
  CONDITION_MISSED: '#d97706',
  COMPUTE_SLIP: '#0891b2',
  READING_SLIP: '#7c3aed',
  CHECK_OMITTED: '#64748b',
  UNKNOWN: '#9ca3af',
}

/**
 * 错题看板（M5）。
 *
 * 展示错因分布。没有数据时明确说明原因，而不是画一个空图表让人以为坏了。
 */
export default async function AnalyticsPage() {
  const [stats, catalog] = await Promise.all([fetchErrorTags('30d'), fetchErrorCatalog()])
  const max = Math.max(1, ...stats.distribution.map((item) => item.count))

  return (
    <main style={{ padding: 32, maxWidth: 820, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>错题看板</h1>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>最近 {stats.range}</span>
        <Link href="/" style={{ color: '#2563eb', fontSize: 13, marginLeft: 'auto' }}>← 返回画布列表</Link>
      </div>

      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
        错因来自每道题的选项绑定：答错时选中哪个选项，就暴露了哪一类误解。
      </p>

      <div data-testid="analytics-summary" style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { label: '作答', value: stats.attempts },
          { label: '答错', value: stats.wrongAttempts },
          { label: '已标记错因', value: stats.taggedAttempts },
          { label: '未分析', value: stats.untaggedWrong },
        ].map((item) => (
          <div key={item.label} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 16px', minWidth: 92 }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{item.value}</div>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>{item.label}</div>
          </div>
        ))}
      </div>

      {stats.distribution.length === 0 ? (
        <div data-testid="analytics-empty" style={{ border: '1px dashed #d1d5db', borderRadius: 8, padding: 24, color: '#9ca3af', fontSize: 13 }}>
          {stats.attempts === 0
            ? '还没有作答记录。做完题之后，这里会显示你常犯的错因。'
            : '有作答但没有标记错因。检查题目选项是否都绑定了错因。'}
        </div>
      ) : (
        <section data-testid="error-distribution" style={{ display: 'grid', gap: 10 }}>
          {stats.distribution.map((item) => (
            <div key={item.code} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 84, fontSize: 13, color: '#374151' }}>{CATEGORY_LABEL[item.category] ?? item.label}</span>
              <div style={{ flex: 1, background: '#f1f5f9', borderRadius: 4, height: 20, position: 'relative', overflow: 'hidden' }}>
                <div
                  data-testid={`bar-${item.code}`}
                  style={{
                    width: `${(item.count / max) * 100}%`,
                    background: CATEGORY_COLOR[item.category] ?? '#94a3b8',
                    height: '100%',
                    borderRadius: 4,
                  }}
                />
              </div>
              <span style={{ width: 40, fontSize: 12, color: '#6b7280', textAlign: 'right' }}>{item.count}</span>
            </div>
          ))}
        </section>
      )}

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#374151' }}>错因词典</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {catalog.map((tag) => (
            <span key={tag.code} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: '#f8fafc', border: '1px solid #e5e7eb', color: '#475569' }}>
              {tag.label}
            </span>
          ))}
        </div>
      </section>
    </main>
  )
}
