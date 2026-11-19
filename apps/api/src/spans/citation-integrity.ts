import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import type { ObjectStore } from '../storage/object-store.ts'
import { classifyClaim, matchesStoredSpan } from './claim-support.ts'
import { readPageTexts } from '../storage/page-text.ts'
import type { StoredPageText } from '../storage/page-text.ts'
export { pageTextKey } from '../storage/page-text.ts'

/**
 * 引用漂移巡检（SG-SUP-005 缺陷 A 的「真实卡片验证」）。
 *
 * 判定：`Span.text` 与原文页文本逐字符比对，任何一条引用对不上，
 * 该 `Concept` 从 `VERIFIED` 降级为 `UNVERIFIED`。
 *
 * 降级方向不会被 guards 里的 BEFORE UPDATE 触发器拦（它只拦"升到 VERIFIED"），
 * 这一点 M1 实测过。
 *
 * 页文本位置约定（与 SourceDoc.textKey 一致）：
 *   `canvas/<canvasId>/source/<sourceId>/text.json` → `[{ page, text }, ...]`
 */

export interface CitationFailure {
  readonly conceptId: string
  readonly spanId: string
  readonly reason: string
  readonly detail: string
}

export interface IntegrityReport {
  readonly checked: number
  readonly downgraded: string[]
  readonly failures: CitationFailure[]
  /** 取不到原文的源（S3 挂着或没上传），这些不做降级，只报告 */
  readonly unverifiableSources: string[]
}

export interface IntegrityDeps {
  readonly prisma: PrismaClient
  readonly objectStore: ObjectStore
}

export async function checkConceptCitations(deps: IntegrityDeps, canvasFilter?: string): Promise<IntegrityReport> {
  const concepts = await deps.prisma.concept.findMany({
    // SG-SUP-010 §2.2：待审的也要巡检，否则它永远没人复查
    where: {
      status: { in: ['VERIFIED', 'PENDING_REVIEW'] },
      ...(canvasFilter ? { canvasId: canvasFilter } : {}),
    },
    include: {
      citations: {
        include: { span: { include: { source: { include: { node: true } } } } },
      },
    },
  })

  const cache = new Map<string, StoredPageText[] | null>()
  const failures: CitationFailure[] = []
  const downgraded: string[] = []
  const unverifiable = new Set<string>()

  for (const concept of concepts) {
    let conceptFailed = concept.citations.length === 0
    if (conceptFailed) {
      failures.push({ conceptId: concept.id, spanId: '', reason: 'NO_CITATIONS', detail: '缺少引用' })
    }

    for (const citation of concept.citations) {
      const span = citation.span
      const canvasId = span.source.node.canvasId
      if (!cache.has(span.sourceId)) {
        cache.set(span.sourceId, await readPageTexts(deps.objectStore, canvasId, span.sourceId))
      }
      const pages = cache.get(span.sourceId)

      if (!pages) {
        unverifiable.add(span.sourceId)
        continue
      }

      const rangeValid = matchesStoredSpan(span, pages)
      const classification = classifyClaim({
        name: concept.name,
        definition: concept.definition,
        quote: citation.quote ?? undefined,
        spanText: span.text,
      })
      // PENDING_REVIEW 的卡同样要复查：挂着"待审"却没人看，等于无人区
      // 这里只要求 A1（引文逐字可查）成立；定义措辞的好坏由人判，不由巡检判
      const supported = classification.reasons.every((reason) => reason !== 'A1_QUOTE_NOT_IN_SPAN' && reason !== 'NO_QUOTE')
      if (!rangeValid || !supported) {
        conceptFailed = true
        failures.push({ conceptId: concept.id, spanId: span.id, reason: rangeValid ? 'UNSUPPORTED_DEFINITION' : 'TEXT_MISMATCH', detail: `page=${span.page} region=${span.region}` })
      }
    }

    if (conceptFailed) {
      await deps.prisma.concept.update({ where: { id: concept.id }, data: { status: 'UNVERIFIED' } })
      downgraded.push(concept.id)
    }
  }

  return {
    checked: concepts.length,
    downgraded,
    failures,
    unverifiableSources: [...unverifiable],
  }
}
