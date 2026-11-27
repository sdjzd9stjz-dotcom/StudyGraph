'use client'

import { useEffect, useRef, useState } from 'react'
import { MathText } from '../MathText'
import type { SplitDetail, SplitReport } from '../../../../packages/contracts/src/split-report'

export interface SplitReportView { report: SplitReport; skipped: SplitDetail[]; preview: boolean }

export function SplitReportDialog({ view, onClose }: { view: SplitReportView; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(50)
  useEffect(() => { dialog.current?.showModal() }, [])
  const { report } = view
  const filtered = view.skipped.filter(row => [row.name, ...row.details].some(value => value.includes(query.trim())))
  return <dialog ref={dialog} onClose={onClose} aria-labelledby="split-report-title" data-testid="split-report"
    style={{ maxWidth: 680, width: '85vw', maxHeight: '75vh', border: '1px solid #cbd5e1', borderRadius: 10, padding: 20 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <h2 id="split-report-title" style={{ fontSize: 18 }}>{view.preview ? '当前拆分明细' : '本次拆分结果'}</h2>
      <button type="button" onClick={() => dialog.current?.close()}>关闭</button>
    </div>
    <p>抽取 {report.total} 条 · {view.preview ? '可新建' : '新建'} {report.newNodes} 张 · 已有同名卡 {report.existing} 条 · 本批同名 {report.repeated} 条 · 未满足建卡条件 {report.blocked} 条</p>
    {report.blocked > 0 && <><h3 style={{ fontSize: 15 }}>未建卡的首要原因</h3><ul>{report.primaryReasons.map(group => <li key={group.reason}>{group.reason}（{group.count} 条）</li>)}</ul></>}
    <p style={{ color: '#475569', fontSize: 13 }}>统计范围是该节点最近一次抽取的条目。新卡节点运行后才会生成卡片内容。核对整套证明还需要对照原文中的证明步骤。</p>
    {view.skipped.length > 0 && <>
      <label>查找概念名称或原因 <input type="search" value={query} onChange={e => { setQuery(e.target.value); setLimit(50) }} /></label>
      <p>未新建的条目 · 匹配 {filtered.length} 条</p>
      {filtered.slice(0, limit).map(row => <details key={row.index} style={{ margin: '8px 0' }}>
        <summary>{row.index}. <MathText>{row.name}</MathText> · {row.reason}</summary>
        <p>{row.details.join('；')}</p>
        {row.definition && <p>抽取的定义：<MathText>{row.definition}</MathText></p>}{row.quote && <blockquote>引用文字：<MathText>{row.quote}</MathText></blockquote>}
      </details>)}
      {filtered.length > limit && <button onClick={() => setLimit(limit + 50)}>再显示 50 条</button>}
    </>}
  </dialog>
}
