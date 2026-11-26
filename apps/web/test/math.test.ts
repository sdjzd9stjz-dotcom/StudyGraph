import assert from 'node:assert/strict'
import test from 'node:test'
import { splitMath } from '../../../packages/contracts/src/math-text.ts'
import { typeset } from '../lib/math-html.ts'
import { renderLectureHtml } from '../lib/lecture-html.ts'

const expressions = (s: string) => splitMath(s).filter(p => p.formula)
test('四种定界符、相邻公式、独立环境和换行', () => {
  const s = String.raw`定义 $a$、\(b\)，$$\frac{1}{2}$$\[\sqrt{x}\]
\begin{align*}a&=b\\c&=d\end{align*}`
  assert.equal(splitMath(s).map(p => p.raw).join(''), s)
  assert.deepEqual(expressions(s).map(p => p.display), [false, false, true, true, true])
  for (const p of expressions(s)) assert.match(typeset(p)!, /<math/)
})
test('保留货币、转义、代码和未完成的内容', () => {
  const s = ['价格 $5 到 $10；\\$5', '`$x$` 和 ``a`$y$``', '```js', 'const x = "$y$"', '```', '$z$ 和 \\(未完成'].join('\n')
  assert.deepEqual(expressions(s).map(p => p.formula), ['z'])
  assert.equal(splitMath(s).map(p => p.raw).join(''), s)
  assert.equal(typeset(expressions(String.raw`$\notARealCommand$`)[0]!), null)
  assert.doesNotMatch(typeset(expressions(String.raw`$\href{https://example.org}{x}$`)[0]!) ?? '', /<a\b/)
})
test('独立打印 HTML 中的多行公式、普通代码和不可信文本', () => {
  const html = renderLectureHtml('导数 $x$', '## 定义\n$$\n\\frac{x}{2}\n$$\n`$code$` <script>alert(1)</script>\n- **结果** $y$')
  assert.equal((html.match(/<math\b/g) ?? []).length, 3)
  assert.match(html, /<mfrac>/); assert.match(html, /<code>\$code\$<\/code>/); assert.match(html, /<strong>结果<\/strong>/)
  assert.doesNotMatch(html, /<script>|<link\b/)
})
