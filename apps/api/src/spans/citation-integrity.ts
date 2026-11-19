import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import type { ObjectStore } from '../storage/object-store.ts'
import type { SpanRef } from '../../../../packages/contracts/src/index.ts'
import { verifySpan } from './resolver.ts'

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

export function pageTextKey(canvasId: string, sourceId: string): string {
  return `canvas/${canvasId}/source/${sourceId}/text.json`
}

async function loadPages(
  deps: IntegrityDeps,
  canvasId: string,
  sourceId: string,
  cache: Map<string, Map<number, string> | null>,
): Promise<Map<number, string> | null> {
  const cached = cache.get(sourceId)
  if (cached !== undefined) return cached

  try {
    const bytes = await deps.objectStore.get(pageTextKey(canvasId, sourceId))
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Array<{ page: number; text: string }>
    const map = new Map(parsed.map((entry) => [entry.page, entry.text]))
    cache.set(sourceId, map)
    return map
  } catch {
    cache.set(sourceId, null)
    return null
  }
}

export async function checkConceptCitations(deps: IntegrityDeps): Promise<IntegrityReport> {
  const concepts = await deps.prisma.concept.findMany({
    where: { status: 'VERIFIED' },
    include: {
      citations: {
        include: { span: { include: { source: { include: { node: true } } } } },
      },
    },
  })

  const cache = new Map<string, Map<number, string> | null>()
  const failures: CitationFailure[] = []
  const downgraded: string[] = []
  const unverifiable = new Set<string>()

  for (const concept of concepts) {
    let conceptFailed = false

    for (const citation of concept.citations) {
      const span = citation.span
      const canvasId = span.source.node.canvasId
      const pages = await loadPages(deps, canvasId, span.sourceId, cache)

      if (!pages) {
        unverifiable.add(span.sourceId)
        continue
      }

      const result = verifySpan(span as unknown as SpanRef, pages)
      if (!result.ok) {
        conceptFailed = true
        failures.push({ conceptId: concept.id, spanId: span.id, reason: result.reason, detail: result.detail })
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
