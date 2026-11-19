/**
 * 概念论断的支撑判定（SG-SUP-010 §1.3 三档）。
 *
 * 原来只有一个布尔：`definition.trim() === quote`，把两件事绑成了一条规则——
 * 「引文在不在原文里」（机械可验）与「定义是不是这条引文的合理转述」（只能人来判）。
 * 结果两头都不对：忠实的转述被当成造假拦下，真正该拦的又分不出来。
 *
 * 现在拆成两个判定、三档结论：
 *
 *   A1  引文能否在 span 原文里逐字查到   → 查不到 = 造假，直接 T3
 *   A2  定义是否由引文支撑（bigram 相似 + 长度比） → 只影响 T1/T2
 *
 * **A1 一秒都不能松**：T2（待人复核）的引文同样是逐字可查的，它只是措辞不是原文。
 */
import {
  REVIEW_MAX_LENGTH_RATIO,
  REVIEW_MIN_BIGRAM_SIMILARITY,
  REVIEW_MIN_LENGTH_RATIO,
} from '../../../../packages/contracts/src/index.ts'

export type ClaimVerdict = 'VERIFIED' | 'PENDING_REVIEW' | 'UNVERIFIED'

export type ClaimReason =
  | 'NO_QUOTE'
  | 'A1_QUOTE_NOT_IN_SPAN'
  | 'EMPTY_DEFINITION'
  | 'NAME_NOT_IN_DEFINITION'
  | 'NO_PREDICATE'
  | 'BELOW_SIMILARITY'
  | 'LENGTH_RATIO_OUT_OF_RANGE'
  | 'DEFINITION_EQUALS_NAME'

export interface ClaimClassification {
  readonly verdict: ClaimVerdict
  readonly reasons: ClaimReason[]
  /** 字符 bigram Jaccard 相似度（去空白与标点后） */
  readonly similarity: number
  /** len(definition) / len(quote)，quote 为空时记 0 */
  readonly lengthRatio: number
}

const PREDICATE = /是|指|称为|叫做|称作|等于|满足|存在|定义为|当且仅当|\b(?:is|are|means|denotes|refers to)\b/iu

/** 去空白、标点、符号：中文没有词边界，只能按字比较 */
export function normalizeForCompare(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '')
}

function bigrams(text: string): Set<string> {
  const chars = [...normalizeForCompare(text)]
  if (chars.length < 2) return new Set(chars)
  const set = new Set<string>()
  for (let i = 0; i < chars.length - 1; i++) set.add(chars[i]! + chars[i + 1]!)
  return set
}

/** 纯机械、可复现、无模型参与——不许用"模型说等价"当判据 */
export function bigramJaccard(a: string, b: string): number {
  const X = bigrams(a)
  const Y = bigrams(b)
  if (X.size === 0 || Y.size === 0) return 0
  let intersection = 0
  for (const gram of X) if (Y.has(gram)) intersection += 1
  return intersection / (X.size + Y.size - intersection)
}

export function classifyClaim(input: {
  name: string
  definition: string
  quote?: string | undefined
  spanText: string
}): ClaimClassification {
  const name = (input.name ?? '').trim()
  const definition = (input.definition ?? '').trim()
  const quote = (input.quote ?? '').trim()

  const reasons: ClaimReason[] = []
  const similarity = quote ? bigramJaccard(quote, definition) : 0
  const lengthRatio = quote.length > 0 ? definition.length / quote.length : 0

  // A1：引文必须逐字出现在 span 原文里。这一条失败就是造假，直接 T3。
  if (quote.length === 0) return { verdict: 'UNVERIFIED', reasons: ['NO_QUOTE'], similarity, lengthRatio }
  if (!input.spanText.includes(quote)) {
    return { verdict: 'UNVERIFIED', reasons: ['A1_QUOTE_NOT_IN_SPAN'], similarity, lengthRatio }
  }

  if (definition.length === 0) {
    return { verdict: 'UNVERIFIED', reasons: ['EMPTY_DEFINITION'], similarity, lengthRatio }
  }

  // 结构条件：名称要在定义里，定义要有谓词（"X 是/指/称为…"），否则只是标题
  const normalizedName = normalizeForCompare(name)
  const normalizedDefinition = normalizeForCompare(definition)
  if (normalizedName.length === 0 || !normalizedDefinition.includes(normalizedName)) {
    reasons.push('NAME_NOT_IN_DEFINITION')
  }
  if (normalizedDefinition === normalizedName) reasons.push('DEFINITION_EQUALS_NAME')
  if (!PREDICATE.test(definition)) reasons.push('NO_PREDICATE')

  if (reasons.length > 0) return { verdict: 'UNVERIFIED', reasons, similarity, lengthRatio }

  // T1：定义与引文逐字相同
  if (definition === quote) return { verdict: 'VERIFIED', reasons: [], similarity, lengthRatio }

  // T2：措辞不同但语义被引文支撑
  if (similarity < REVIEW_MIN_BIGRAM_SIMILARITY) reasons.push('BELOW_SIMILARITY')
  if (lengthRatio < REVIEW_MIN_LENGTH_RATIO || lengthRatio > REVIEW_MAX_LENGTH_RATIO) {
    reasons.push('LENGTH_RATIO_OUT_OF_RANGE')
  }

  if (reasons.length > 0) return { verdict: 'UNVERIFIED', reasons, similarity, lengthRatio }

  return { verdict: 'PENDING_REVIEW', reasons: [], similarity, lengthRatio }
}

/** 兼容旧调用点：只有 T1 才算"自动通过" */
export function supportsDefinition(
  name: string,
  definition: string,
  quote: string | undefined,
  spanText: string,
): boolean {
  return classifyClaim({ name, definition, quote, spanText }).verdict === 'VERIFIED'
}

export function matchesStoredSpan(
  span: { page: number; region?: string; charStart: number; charEnd: number; text: string },
  pages: readonly { page: number; region?: string; text: string }[],
): boolean {
  const page = pages.find((p) => p.page === span.page && (p.region ?? 'PAGE') === (span.region ?? 'PAGE'))
  return (
    !!page &&
    Number.isInteger(span.charStart) &&
    Number.isInteger(span.charEnd) &&
    span.charStart >= 0 &&
    span.charEnd > span.charStart &&
    span.charEnd <= page.text.length &&
    !!span.text.trim() &&
    page.text.slice(span.charStart, span.charEnd) === span.text
  )
}
