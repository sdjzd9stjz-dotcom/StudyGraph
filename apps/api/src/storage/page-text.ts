import type { ObjectStore } from './object-store.ts'

/**
 * 页文本的存储约定（与 SourceDoc.textKey 一致）：
 *   `canvas/<canvasId>/source/<sourceId>/text.json`
 *   内容：`[{ page, region, text }, ...]`
 *
 * 偏移基准见 docs/architecture.md §3.1：**页内文本、UTF-16、[start,end)**。
 * region 让正文与备注页各自独立成基准（SpanRegion）。
 */
export interface StoredPageText {
  readonly page: number
  readonly region: 'PAGE' | 'SLIDE' | 'NOTES'
  readonly text: string
}

export function pageTextKey(canvasId: string, sourceId: string): string {
  return `canvas/${canvasId}/source/${sourceId}/text.json`
}

export function originalKey(canvasId: string, sourceId: string, filename: string): string {
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : ''
  return `canvas/${canvasId}/source/${sourceId}/original${ext}`
}

export async function writePageTexts(
  store: ObjectStore,
  canvasId: string,
  sourceId: string,
  pages: readonly StoredPageText[],
): Promise<string> {
  const key = pageTextKey(canvasId, sourceId)
  await store.put(key, Buffer.from(JSON.stringify(pages), 'utf8'), 'application/json')
  return key
}

export async function readPageTexts(
  store: ObjectStore,
  canvasId: string,
  sourceId: string,
): Promise<StoredPageText[] | null> {
  try {
    const bytes = await store.get(pageTextKey(canvasId, sourceId))
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as StoredPageText[]
  } catch {
    return null
  }
}
