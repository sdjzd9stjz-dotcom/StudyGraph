import { Fragment, memo } from 'react'
import { splitMath } from '../../../packages/contracts/src/math-text.ts'
import { typeset } from '../lib/math-html'

/** 画布拖动会频繁重绘；只有原文发生变化时才重新排版公式。 */
export const MathText = memo(function MathText({ children }: { children: string }) {
  return <>{splitMath(children).map((part, index) => {
    const html = typeset(part)
    if (!html) return <Fragment key={index}>{part.raw}</Fragment>
    return <span key={index} className={part.display ? 'sg-math-block' : 'sg-math-inline'} dangerouslySetInnerHTML={{ __html: html }} />
  })}</>
})
