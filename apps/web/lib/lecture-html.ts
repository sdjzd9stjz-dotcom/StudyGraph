/**
 * 讲义 Markdown → 打印用 HTML。
 *
 * 为什么不用 markdown-it / remark：只为打印一份讲义引入一个渲染依赖不划算，
 * 而这里支持的语法（标题、列表、粗体、行内代码、代码块、引用、公式行）正好够用。
 *
 * 安全：先转义 HTML，再做行内替换 —— 顺序反了，模型写出 `<script>` 就会被真的执行
 * （讲义来自模型，模型输出属于不可信内容）。
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\$([^$]+)\$/g, '<span class="math">$1</span>')
}

function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let inCode = false

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()

    if (line.startsWith('```')) {
      if (inCode) {
        out.push('</pre>')
        inCode = false
      } else {
        closeList()
        out.push('<pre>')
        inCode = true
      }
      continue
    }
    if (inCode) {
      out.push(escapeHtml(raw))
      continue
    }

    if (line.trim().length === 0) {
      closeList()
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1]!.length + 1 // markdown 的 # 对应 PDF 的 h2 起
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
      continue
    }

    const ordered = /^\s*(\d+)[.、)]\s+(.*)$/.exec(line)
    if (ordered) {
      if (list !== 'ol') {
        closeList()
        out.push('<ol>')
        list = 'ol'
      }
      out.push(`<li>${inline(ordered[2]!)}</li>`)
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      if (list !== 'ul') {
        closeList()
        out.push('<ul>')
        list = 'ul'
      }
      out.push(`<li>${inline(bullet[1]!)}</li>`)
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      closeList()
      out.push(`<blockquote>${inline(quote[1]!)}</blockquote>`)
      continue
    }

    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }

  closeList()
  if (inCode) out.push('</pre>')
  return out.join('\n')
}

export function renderLectureHtml(title: string, markdown: string): string {
  const body = renderMarkdown(markdown)
  const safeTitle = escapeHtml(title)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
<style>
  /* 打印样式：A4、中文优先、页边距交给 printToPDF */
  @page { size: A4; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans SC", "SimSun", sans-serif;
    font-size: 11.5pt;
    line-height: 1.8;
    color: #1f2937;
    margin: 0;
  }
  h1 { font-size: 22pt; margin: 0 0 6mm; color: #0f172a; }
  h2 { font-size: 15pt; margin: 8mm 0 3mm; padding-bottom: 1.5mm; border-bottom: 1px solid #cbd5e1; color: #0f172a; }
  h3 { font-size: 13pt; margin: 6mm 0 2mm; color: #111827; }
  h4 { font-size: 12pt; margin: 5mm 0 2mm; }
  p { margin: 2mm 0; }
  ul, ol { margin: 2mm 0 2mm 6mm; padding: 0; }
  li { margin: 1mm 0; }
  blockquote { margin: 3mm 0; padding: 2mm 4mm; border-left: 3px solid #94a3b8; color: #475569; background: #f8fafc; }
  code { font-family: Consolas, "Courier New", monospace; background: #f1f5f9; padding: 0 1mm; border-radius: 2px; font-size: 10pt; }
  pre { background: #f8fafc; border: 1px solid #e2e8f0; padding: 3mm; white-space: pre-wrap; word-break: break-word; font-size: 10pt; }
  .math { font-family: "Cambria Math", "Times New Roman", serif; font-style: italic; }
  .footer { margin-top: 12mm; padding-top: 3mm; border-top: 1px solid #e2e8f0; font-size: 9pt; color: #94a3b8; }
</style>
</head>
<body>
  <h1>${safeTitle}</h1>
  ${body}
  <div class="footer">由 StudyGraph 根据画布节点的产出与对话生成</div>
</body>
</html>`
}
