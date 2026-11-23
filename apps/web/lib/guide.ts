import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 应用内使用教程。
 *
 * 为什么读 docs/使用说明书.md 而不是把正文抄进来：
 * 抄一份就会分叉 —— 说明书改了、应用里的教程还是旧的，用户照着旧步骤做会失败。
 * 但打包后 docs/ 不在 web 产物里，所以 getGuideMarkdown 会按几个候选路径找，
 * 构建脚本负责把说明书复制进产物（scripts/build-desktop.mjs）。
 *
 * 找不到时**明确说明**，不返回空字符串：空白教程比没有教程更让人困惑。
 */
/**
 * 打包后的实际位置：web 的 standalone 根在 <app>/apps/web/.next/standalone，
 * cwd 是 standalone/apps/web —— 构建脚本把说明书放在这里（见 build-desktop.mjs §2.4）。
 * 开发期从仓库根或 apps/web 启动都能找到 docs/。
 */
const CANDIDATES = [
  path.join(process.cwd(), 'docs', '使用说明书.md'),
  path.join(process.cwd(), '..', '..', 'docs', '使用说明书.md'),
  path.join(process.cwd(), '..', '..', '..', 'docs', '使用说明书.md'),

]

export interface GuideLoad {
  readonly markdown: string
  readonly source: string | null
}

export function loadGuide(): GuideLoad {
  for (const candidate of CANDIDATES) {
    try {
      const markdown = readFileSync(candidate, 'utf8')
      if (markdown.trim().length > 0) return { markdown, source: candidate }
    } catch {
      // 试下一个候选路径
    }
  }
  return {
    markdown:
      '# 教程读取失败\n\n找不到 `使用说明书.md`。\n\n' +
      '这通常是打包时漏了 `docs/` 目录，不影响软件使用：\n' +
      '- 画布左上角「▦ 整理」按依赖方向重排节点\n' +
      '- 节点上 💬 可以就这个节点的内容提问，▶ 运行它\n' +
      '- 底部对话框可以直接说「把课件做成知识卡」，它会动手建节点\n\n' +
      '完整说明书见安装目录同级的 `docs/使用说明书.pdf`。',
    source: null,
  }
}

/** 极简 Markdown → HTML。只覆盖说明书用到的语法，避免为一份静态文档引入渲染依赖。 */
export function guideToHtml(markdown: string): string {
  const escapeHtml = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const inline = (text: string) =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="link">$1</span>')

  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inCode = false
  let listType: 'ul' | 'ol' | null = null
  let tableOpen = false

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`)
      listType = null
    }
  }
  const closeTable = () => {
    if (tableOpen) {
      out.push('</tbody></table>')
      tableOpen = false
    }
  }

  const cells = (row: string) =>
    row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!
    const line = raw.trimEnd()

    if (line.startsWith('```')) {
      if (inCode) {
        out.push('</code></pre>')
        inCode = false
      } else {
        closeList()
        closeTable()
        out.push('<pre><code>')
        inCode = true
      }
      continue
    }
    if (inCode) {
      out.push(escapeHtml(raw))
      continue
    }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      closeList()
      closeTable()
      out.push('<table><thead><tr>' + cells(line).map((cell) => `<th>${inline(cell)}</th>`).join('') + '</tr></thead><tbody>')
      tableOpen = true
      i += 1
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1]!)) {
        i += 1
        out.push('<tr>' + cells(lines[i]!).map((cell) => `<td>${inline(cell)}</td>`).join('') + '</tr>')
      }
      closeTable()
      continue
    }

    if (/^---+\s*$/.test(line)) {
      closeList()
      closeTable()
      out.push('<hr />')
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      closeTable()
      // 内嵌教程从 h1 开始会太大，整体降一级
      const level = Math.min(6, heading[1]!.length + 1)
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
      continue
    }

    const ordered = /^\s*\d+[.)、]\s+(.*)$/.exec(line)
    if (ordered) {
      if (listType !== 'ol') {
        closeList()
        out.push('<ol>')
        listType = 'ol'
      }
      out.push(`<li>${inline(ordered[1]!)}</li>`)
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      if (listType !== 'ul') {
        closeList()
        out.push('<ul>')
        listType = 'ul'
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

    if (line.trim().length === 0) {
      closeList()
      continue
    }

    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }

  closeList()
  closeTable()
  if (inCode) out.push('</code></pre>')
  return out.join('\n')
}
