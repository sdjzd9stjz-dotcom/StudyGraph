export type MathPart = { raw: string; formula?: string; display?: boolean }

// 模型在讲义、对话里既会写公式，也会把公式源码放进代码示例。
// 保留 raw 让显示失败、摘要截断和复制共用同一份原文。
export function splitMath(text: string): MathPart[] {
  const parts: MathPart[] = []
  const tokens = /`+|~{3,}|\\begin\{(align\*?|alignat\*?|gather\*?|equation\*?|multline\*?)\}|\\[\s\S]|\${1,2}/g
  let plainStart = 0
  for (let hit = tokens.exec(text); hit; hit = tokens.exec(text)) {
    const open = hit[0], start = hit.index, after = tokens.lastIndex
    if (open.startsWith('`') || open.startsWith('~')) {
      const fenced = open.length >= 3 && /^ {0,3}$/.test(text.slice(text.lastIndexOf('\n', start - 1) + 1, start))
      if (!fenced && open.startsWith('~')) continue
      const close = fenced ? new RegExp('^ {0,3}' + open[0] + '{' + open.length + ',}[ \\t]*\\r?$', 'gm') : new RegExp('(?<!`)' + open + '(?!`)', 'g')
      close.lastIndex = after
      const end = close.exec(text)
      if (end) tokens.lastIndex = close.lastIndex
      else if (fenced) break
      continue
    }
    const env = hit[1]
    const close = env ? `\\end{${env}}` : ({ '$': '$', '$$': '$$', '\\(': '\\)', '\\[': '\\]' } as Record<string, string>)[open]
    if (!close || (open === '$' && /\s/.test(text[after] ?? ' '))) continue
    const display = !!env || open === '$$' || open === '\\['
    let depth = 0
    // 给异常或尚未收齐的模型输出设定界限，避免在很长的画布上反复扫描整段历史。
    const limit = Math.min(text.length, after + 16384)
    for (let i = after; i < limit; i++) {
      const c = text[i]
      if (c === '`' || (c === '\n' && open === '$')) break
      if (depth === 0 && text.startsWith(close, i)) {
        if (open === '$' && (/\s/.test(text[i - 1]!) || text[i + 1] === '$' || /\d/.test(text[i + 1] ?? ''))) break
        const end = i + close.length
        const raw = text.slice(start, end), formula = env ? raw : text.slice(after, i)
        if (formula.trim()) {
          if (start > plainStart) parts.push({ raw: text.slice(plainStart, start) })
          parts.push({ raw, formula, display })
          plainStart = end
          tokens.lastIndex = end
        }
        break
      }
      if (c === '\\') i++
      else if (c === '{') depth++
      else if (c === '}') depth = Math.max(0, depth - 1)
    }
  }
  if (plainStart < text.length) parts.push({ raw: text.slice(plainStart) })
  return parts
}
