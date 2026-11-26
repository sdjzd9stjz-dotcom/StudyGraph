import katex from 'katex'
import type { MathPart } from '../../../packages/contracts/src/math-text.ts'

/** 打印窗口离线且禁用脚本，原生 MathML 可以随讲义一起交给 Chromium。 */
export function typeset(part: MathPart, printing = false): string | null {
  if (!part.formula) return null
  try {
    return katex.renderToString(part.formula, {
      displayMode: part.display, output: printing ? 'mathml' : 'htmlAndMathml',
      trust: false, throwOnError: true, strict: 'ignore', maxExpand: 500, maxSize: 12,
    })
  } catch {
    return null
  }
}
