import { TEXT_LAYER } from '../../../../packages/contracts/src/index.ts'

/**
 * 文字层可用性判定（SG-SUP-008 §2.3）。
 *
 * 背景：`高代.pdf` 是 0 字符（好拦），但《数学分析》261 页里 30 页有零星字符——
 * 典型劣质 OCR：「⾃ 整 有理实」「苦 tO'P 1时⼀⼀an Hit it」。
 * 这些字符能通过 span 校验，最后会变成"引用一段谁也没法验证的乱码"的假卡。
 *
 * 所以判定分两层：
 *   1. 有没有文字（调用方处理）
 *   2. **文字能不能用**（本模块）
 */

export interface PageTextSample {
  readonly page: number
  readonly text: string
}

export interface TextLayerAssessment {
  readonly usable: boolean
  readonly totalPages: number
  readonly nonEmptyPages: number
  readonly effectivePages: number
  readonly effectiveRatio: number
  readonly kangxiRatio: number
  readonly vowelLessLatinRatio: number
  readonly singleCharPageRatio: number
  readonly signals: string[]
  readonly reason: string
}

/** 康熙部首 U+2F00–U+2FDF 与兼容汉字 U+2F800–U+2FA1F：正常中文文本几乎不用。 */
function isKangxi(code: number): boolean {
  return (code >= 0x2f00 && code <= 0x2fdf) || (code >= 0x2f800 && code <= 0x2fa1f)
}

function isCjk(code: number): boolean {
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)
}

function isLatinLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

const VOWELS = /[aeiouyAEIOUY]/

/** 不可印刷字符（控制符、私用区、替换符）直接算噪音。 */
function isNoise(code: number): boolean {
  return code === 0xfffd || (code >= 0xe000 && code <= 0xf8ff) || (code < 0x20 && code !== 0x09 && code !== 0x0a)
}

export function assessTextLayer(pages: readonly PageTextSample[]): TextLayerAssessment {
  const totalPages = pages.length
  const nonEmpty = pages.filter((page) => page.text.trim().length > 0)

  let kangxi = 0
  let totalChars = 0
  let latinTokens = 0
  let vowelLessTokens = 0

  for (const page of nonEmpty) {
    for (const char of page.text) {
      totalChars += 1
      const code = char.codePointAt(0) ?? 0
      if (isKangxi(code)) kangxi += 1
    }

    // 拉丁串：连续字母组成的 token
    for (const token of page.text.match(/[A-Za-z]{2,}/g) ?? []) {
      latinTokens += 1
      if (!VOWELS.test(token)) vowelLessTokens += 1
    }
  }

  const kangxiRatio = totalChars > 0 ? kangxi / totalChars : 0
  const vowelLessLatinRatio = latinTokens > 0 ? vowelLessTokens / latinTokens : 0
  const singleCharPages = nonEmpty.filter((page) => page.text.trim().length === 1).length
  const singleCharPageRatio = nonEmpty.length > 0 ? singleCharPages / nonEmpty.length : 0

  // 标准 A：有效页 = 字符数够 且 该页本身不是纯乱码
  const effectivePages = nonEmpty.filter((page) => {
    const text = page.text.trim()
    if (text.length < TEXT_LAYER.minEffectivePageChars) return false
    const pageKangxi = [...text].filter((char) => isKangxi(char.codePointAt(0) ?? 0)).length
    const pageNoise = [...text].filter((char) => isNoise(char.codePointAt(0) ?? 0)).length
    return pageKangxi / text.length <= TEXT_LAYER.maxKangxiRatio * 5 && pageNoise / text.length <= 0.05
  }).length

  const effectiveRatio = totalPages > 0 ? effectivePages / totalPages : 0

  const signals: string[] = []
  if (kangxiRatio > TEXT_LAYER.maxKangxiRatio) {
    signals.push(`康熙部首/兼容汉字占比 ${(kangxiRatio * 100).toFixed(2)}% > ${TEXT_LAYER.maxKangxiRatio * 100}%`)
  }
  if (vowelLessLatinRatio > TEXT_LAYER.maxVowelLessLatinRatio && latinTokens >= 5) {
    signals.push(`无元音拉丁串占比 ${(vowelLessLatinRatio * 100).toFixed(1)}%（${vowelLessTokens}/${latinTokens}）`)
  }
  if (singleCharPageRatio > TEXT_LAYER.maxSingleCharPageRatio) {
    signals.push(`单字符页占比 ${(singleCharPageRatio * 100).toFixed(1)}%（${singleCharPages}/${nonEmpty.length}）`)
  }

  const tooFewEffective = effectiveRatio < TEXT_LAYER.minEffectivePageRatio
  const tooManySignals = signals.length >= TEXT_LAYER.minGibberishSignals
  const usable = effectiveRatio > 0 && !tooManySignals && !(tooFewEffective && signals.length >= 1)

  const reason = usable
    ? `有效页 ${effectivePages}/${totalPages}（${(effectiveRatio * 100).toFixed(1)}%）`
    : `有效页 ${effectivePages}/${totalPages}（${(effectiveRatio * 100).toFixed(1)}%），乱码特征 ${signals.length} 条` +
      (signals.length > 0 ? `：${signals.join('；')}` : '')

  return {
    usable,
    totalPages,
    nonEmptyPages: nonEmpty.length,
    effectivePages,
    effectiveRatio,
    kangxiRatio,
    vowelLessLatinRatio,
    singleCharPageRatio,
    signals,
    reason,
  }
}
