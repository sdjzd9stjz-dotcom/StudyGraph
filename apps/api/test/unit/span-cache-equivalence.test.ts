import assert from 'node:assert/strict'
import test from 'node:test'

import type { SpanRef } from '../../../../packages/contracts/src/index.ts'
import { createSpanResolver, verifySpan } from '../../src/spans/resolver.ts'

/**
 * 缓存路径必须与"直接校验"给出**完全相同的结论**（SG-SUP-006 §1.4 第 3 问的防线）。
 *
 * 做法：对随机生成的 (页文本, span, 期望文本, 版本函数) 组合，
 * 分别跑 `resolver.verify`（走缓存）与 `verifySpan`（纯函数，无缓存），逐字段比对。
 *
 * 这条测试能抓住的 bug：
 * - 缓存键漏了判定函数的某个输入（例如 span.text）→ 第二轮换了期望文本仍命中旧结论
 * - 版本取不到（undefined）时仍复用缓存 → 页文本变了却回 true
 * - 缓存的键冲突（不同 span 撞到同一个键）
 *
 * 断言删掉会漏什么：随便漏掉上面任意一条，缓存就会在某个输入组合上把 false 变成 true，
 * 而 M2 之后每张卡都建立在它上面。
 */

const CHARS = ['a', 'b', 'c', '定', '积', '分', ' ', '\n', '1', '+']

function randomPageText(): string {
  const length = 1 + Math.floor(Math.random() * 30)
  let out = ''
  for (let i = 0; i < length; i++) out += CHARS[Math.floor(Math.random() * CHARS.length)]
  return out
}

function randomSpan(pageText: string): SpanRef {
  const length = pageText.length
  const start = Math.floor(Math.random() * (length + 2)) - 1 // 允许 -1，覆盖负偏移
  const end = start + Math.floor(Math.random() * 5)
  const expected = start >= 0 && end <= length && end > start ? pageText.slice(start, end) : 'zz'
  return { id: 's', sourceId: 'src', page: 1, charStart: start, charEnd: end, text: expected }
}

test('缓存路径 ≡ 无缓存路径（200 组随机输入，含改期望文本/改页文本）', async () => {
  for (let round = 0; round < 200; round++) {
    let pageText = randomPageText()
    const span = randomSpan(pageText)

    const resolver = createSpanResolver({
      loadSpan: async () => span,
      loadPageText: async () => pageText,
      // 一半轮次不给版本查询；另一半给一个**随内容变化**的版本（对应生产里的 Source.checksum）。
      // 注意不能给常量：常量版本等于谎报"原文没变"，缓存当然会返回旧结论——那是调用方的错，
      // 不是 resolver 的错。这条契约写在 loadSourceVersion 的注释里。
      ...(round % 2 === 0
        ? {}
        : { loadSourceVersion: async () => `v${pageText.length}:${pageText.slice(0, 4)}` }),
    })

    // ① 首次
    assert.deepEqual(
      await resolver.verify(span),
      verifySpan(span, new Map([[1, pageText]])),
      `第 ${round} 轮首次结论与纯函数不一致`,
    )

    // ② 改期望文本（同一个 id/区间）
    const mutatedText = span.text + 'x'
    const mutated: SpanRef = { ...span, text: mutatedText }
    assert.deepEqual(
      await resolver.verify(mutated),
      verifySpan(mutated, new Map([[1, pageText]])),
      `第 ${round} 轮改期望文本后结论与纯函数不一致`,
    )

    // ③ 改页文本
    pageText = pageText + '尾'
    assert.deepEqual(
      await resolver.verify(span),
      verifySpan(span, new Map([[1, pageText]])),
      `第 ${round} 轮改页文本后结论与纯函数不一致`,
    )

    // ④ 再改一次页文本（确保第二轮缓存的条目也没有被错误复用）
    pageText = 'Z' + pageText
    assert.deepEqual(
      await resolver.verify(mutated),
      verifySpan(mutated, new Map([[1, pageText]])),
      `第 ${round} 轮二次改页文本后结论与纯函数不一致`,
    )
  }
})

test('同一输入重复校验结果稳定（缓存不会制造抖动）', async () => {
  const pageText = '定积分的定义'
  const span: SpanRef = { id: 's', sourceId: 'src', page: 1, charStart: 0, charEnd: 3, text: '定积分' }
  const resolver = createSpanResolver({ loadSpan: async () => span, loadPageText: async () => pageText })

  const first = await resolver.verify(span)
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await resolver.verify(span), first)
  }
  assert.deepEqual(first, verifySpan(span, new Map([[1, pageText]])))
})
