import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import type { ObjectStore } from '../storage/object-store.ts'
import { classifyClaim, matchesStoredSpan } from './claim-support.ts'
import { assessIntegrity } from './integrity-policy.ts'
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
      // 分级巡检（SG-SUP-011 §3.2）：人工认可过的只看引文，自动 VERIFIED 要过完整 T1
      const verdict = assessIntegrity(
        { status: concept.status, reviewedBy: concept.reviewedBy },
        classification,
      )
      if (!rangeValid || !verdict.keep) {
        conceptFailed = true
        failures.push({
          conceptId: concept.id,
          spanId: span.id,
          reason: !rangeValid ? 'TEXT_MISMATCH' : (verdict.keep ? 'TEXT_MISMATCH' : verdict.reason),
          detail: `mode=${verdict.mode} page=${span.page} region=${span.region}`,
        })
      }
    }

    if (conceptFailed) {
      const result = await deps.prisma.concept.updateMany({
        where: { id: concept.id, status: concept.status, updatedAt: concept.updatedAt },
        data: { status: 'UNVERIFIED' },
      })
      if (result.count === 1) downgraded.push(concept.id)
    }
  }

  return {
    checked: concepts.length,
    downgraded,
    failures,
    unverifiableSources: [...unverifiable],
  }
}
