/**
 * 把节点产物（Artifact.structured）转成**给人看的文字**。
 *
 * 为什么需要这一层：产物是结构化 JSON，界面上直接摊开既看不懂也不像"学习笔记"。
 * 但也不能让模型现编一段摘要 —— 那会偏离产物本身，还要多花一次调用。
 * 所以这里是确定性的：只做提取与排版，模型产了什么就显示什么。
 *
 * 输出约定：纯文本、按行组织，客户端用等宽/多行方式渲染成"带解释的卡片"。
 */

const MAX_LINES = 14
const MAX_LINE = 120

function clip(text: string, max = MAX_LINE): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 通用兜底：从任意结构里抽出「名字：说明」这类句子，避免出现一整页 JSON */
function genericLines(data: unknown): string[] {
  const lines: string[] = []
  const push = (line: string) => {
    if (line.trim().length > 0) lines.push(line)
  }

  const visit = (value: unknown, depth: number): void => {
    if (lines.length >= MAX_LINES || depth > 3) return
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 8)) visit(item, depth + 1)
      return
    }
    if (value === null || typeof value !== 'object') return

    const record = value as Record<string, unknown>
    const label =
      str(record.name) || str(record.title) || str(record.stem) || str(record.text) || str(record.question)
    const detail =
      str(record.definition) ||
      str(record.summary) ||
      str(record.explanation) ||
      str(record.rationale) ||
      str(record.note) ||
      str(record.why)
    if (label) push(`• ${clip(label, 60)}${detail ? `：${clip(detail, 70)}` : ''}`)

    for (const [key, child] of Object.entries(record)) {
      if (['name', 'title', 'stem', 'text', 'question', 'definition', 'summary', 'explanation', 'rationale', 'note', 'why'].includes(key)) continue
      visit(child, depth + 1)
    }
  }

  visit(data, 0)
  return lines.slice(0, MAX_LINES)
}

/**
 * 主入口。
 *
 * `kind` 是 ArtifactKind；每个分支只描述"这个节点产出了什么"，
 * 不评价、不补全 —— 产物里没有的东西这里不会出现。
 */
export function summarizeArtifact(kind: string, structured: unknown): string {
  const data = (structured ?? {}) as Record<string, unknown>
  const lines: string[] = []

  switch (kind) {
    case 'SOURCE_TEXT': {
      const doc = (data.sourceDoc ?? {}) as Record<string, unknown>
      lines.push(`📄 ${str(doc.filename) || '课件'}`)
      lines.push(`共 ${num(doc.pageCount) ?? 0} 页 · ${num(doc.spanCount) ?? 0} 个可引用片段`)
      if (str(data.textLayer) === 'OCR') {
        lines.push('⚠ 文字来自 OCR 识别，不是原文，引用前请核对')
      }
      break
    }

    case 'CHUNKS': {
      // 实际形状是 `{ chunkSet: { chunks: [...] } }`（执行器按 outputs 契约包了一层）。
      // 之前写成 `data.chunks ?? data.chunkSet`，拿到的是对象不是数组 → 永远显示 0 段。
      const chunkSet = (data.chunkSet ?? {}) as Record<string, unknown>
      const chunks = asArray(chunkSet.chunks ?? data.chunks)
      lines.push(`✂️ 切成 ${chunks.length} 段`)
      for (const chunk of chunks.slice(0, 5)) {
        const text = str((chunk as Record<string, unknown>)?.text)
        if (text) lines.push(`• ${clip(text, 80)}`)
      }
      break
    }

    case 'CONCEPT_CLAIMS': {
      const claims = asArray((data.conceptClaims as Record<string, unknown>)?.claims)
      lines.push(`🔍 抽出 ${claims.length} 条概念`)
      for (const claim of claims.slice(0, 8)) {
        const record = claim as Record<string, unknown>
        lines.push(`• ${clip(str(record.name), 40)}${str(record.definition) ? `：${clip(str(record.definition), 70)}` : ''}`)
      }
      break
    }

    case 'CONCEPT_CARD': {
      // 同样是 `{ cards: { cards: [...], verified, pendingReview, ... } }`。
      // 读错一层，界面上就是「0 张知识卡」—— 用户会以为抽取白跑了。
      const payload = (data.cards ?? {}) as Record<string, unknown>
      const cards = asArray(payload.cards ?? data.cards)
      const verified = num(payload.verified)
      const pendingReview = num(payload.pendingReview)
      lines.push(
        `🗂 ${cards.length} 张知识卡` +
          (verified !== null || pendingReview !== null
            ? `（已核对 ${verified ?? 0} · 待复核 ${pendingReview ?? 0}）`
            : ''),
      )
      for (const card of cards.slice(0, 8)) {
        const record = card as Record<string, unknown>
        lines.push(`• ${clip(str(record.name), 40)}：${clip(str(record.definition), 80)}`)
      }
      break
    }

    case 'PREREQ_PROPOSAL': {
      lines.push(`🔗 提议 ${num(data.proposed) ?? 0} 条先修关系`)
      // 执行器写的是 `edges`；`pairs` 是模型原始输出，已落库前被过滤掉了
      for (const pair of asArray(data.edges ?? data.pairs).slice(0, 8)) {
        const record = pair as Record<string, unknown>
        lines.push(`• ${clip(str(record.from), 24)} → ${clip(str(record.to), 24)}`)
      }
      const skipped = asArray(data.skipped)
      if (skipped.length > 0) lines.push(`（跳过 ${skipped.length} 条：会成环或缺少证据）`)
      break
    }

    case 'PROBLEM_DRAFT': {
      const created = asArray(data.created)
      lines.push(`✏️ 出题 ${num(data.actual) ?? created.length} 道（要求 ${num(data.requested) ?? '-'} 道）`)
      for (const item of created.slice(0, 6)) {
        lines.push(`• ${clip(str((item as Record<string, unknown>).stem), 90)}`)
      }
      const dropped = asArray(data.dropped)
      if (dropped.length > 0) lines.push(`（丢弃 ${dropped.length} 道：选项没绑错因或缺答案）`)
      break
    }

    case 'GRADING': {
      lines.push(`✅ 批改 ${asArray(data.graded).length} 道`)
      lines.push(`对 ${num(data.correct) ?? 0} · 错 ${num(data.wrong) ?? 0} · 待判 ${num(data.pendingRubric) ?? 0}`)
      break
    }

    case 'REVIEW_PLAN': {
      const plan = asArray(data.plan)
      const summary = (data.summary ?? {}) as Record<string, unknown>
      lines.push(`📅 今日计划 ${plan.length} 张`)
      lines.push(
        `新卡 ${num(summary.newCount) ?? 0} · 逾期 ${num(summary.overdueCount) ?? 0} · 约 ${num(summary.estimatedMinutes) ?? 0} 分钟`,
      )
      for (const item of plan.slice(0, 6)) {
        const record = item as Record<string, unknown>
        lines.push(`• ${clip(str(record.name), 40)}${num(record.overdueDays) ? `（逾期 ${num(record.overdueDays)} 天）` : ''}`)
      }
      break
    }

    case 'GATE_DECISION': {
      lines.push(data.approved === true ? '🟢 已放行' : '🔴 已拒绝')
      if (str(data.note)) lines.push(clip(str(data.note), 100))
      const upstream = (data.upstream ?? {}) as Record<string, unknown>
      const ports = Object.keys(upstream)
      if (ports.length > 0) lines.push(`检查了上游：${ports.join('、')}`)
      break
    }

    case 'PROBE_PROFILE': {
      lines.push('🧭 题型识别')
      lines.push(...genericLines(data).slice(0, 8))
      break
    }

    case 'METHOD_CARD': {
      const steps = asArray(data.steps ?? (data.method as Record<string, unknown>)?.steps)
      lines.push(`🧩 方法：${clip(str(data.name) || str((data.method as Record<string, unknown>)?.name) || '已抽取', 40)}`)
      steps.slice(0, 8).forEach((step, index) => {
        const record = step as Record<string, unknown>
        lines.push(`${index + 1}. ${clip(str(record.text) || str(record.instruction) || str(step), 90)}`)
      })
      if (steps.length === 0) lines.push(...genericLines(data).slice(0, 6))
      break
    }

    case 'SOLUTION_TRACE': {
      const steps = asArray(data.steps)
      lines.push(`🧮 分步解答 ${steps.length} 步`)
      steps.slice(0, 10).forEach((step, index) => {
        const record = step as Record<string, unknown>
        lines.push(`${index + 1}. ${clip(str(record.text) || str(record.expression) || str(step), 90)}`)
        if (str(record.reason)) lines.push(`   理由：${clip(str(record.reason), 70)}`)
      })
      break
    }

    case 'DIAGNOSIS': {
      lines.push('🩺 错因分析')
      lines.push(...genericLines(data).slice(0, 8))
      break
    }

    case 'VARIANT_SET': {
      const variants = asArray(data.variants)
      lines.push(`🔀 变式 ${variants.length} 道`)
      for (const item of variants.slice(0, 6)) {
        const record = item as Record<string, unknown>
        lines.push(`• [${clip(str(record.axis), 16)}] ${clip(str(record.stem), 80)}`)
      }
      break
    }

    case 'DISTRACTOR_SET': {
      const options = asArray(data.options)
      lines.push(`🎯 ${options.length} 个选项（错误项都绑定了错因）`)
      for (const item of options.slice(0, 8)) {
        const record = item as Record<string, unknown>
        lines.push(`• ${clip(str(record.key), 2)}. ${clip(str(record.text), 60)}${str(record.errorTag) ? `（${str(record.errorTag)}）` : ''}`)
      }
      break
    }

    case 'CHECK_VERDICT': {
      lines.push(data.passed === true ? '✅ 三检通过' : '❌ 三检未通过')
      for (const check of asArray((data.result as Record<string, unknown>)?.checks).slice(0, 4)) {
        const record = check as Record<string, unknown>
        lines.push(`${record.pass === true ? '✓' : '✗'} ${clip(str(record.item), 20)}：${clip(str(record.reason), 80)}`)
      }
      break
    }

    case 'PAPER_SPEC': {
      const report = (data.report ?? {}) as Record<string, unknown>
      const items = asArray(data.items ?? report.problems)
      lines.push(`📝 组卷：${num(data.itemCount) ?? items.length} 道`)
      if (num(report.pickedCount) !== null) lines.push(`实取 ${num(report.pickedCount)} 道`)
      for (const gap of asArray(report.gaps).slice(0, 5)) {
        lines.push(`⚠ 缺口：${clip(str(gap), 80)}`)
      }
      break
    }

    default: {
      lines.push(...genericLines(data).slice(0, MAX_LINES))
    }
  }

  const text = lines.filter((line) => line.trim().length > 0).join('\n')
  return text.length > 0 ? text : '（这个节点还没有可显示的内容）'
}
