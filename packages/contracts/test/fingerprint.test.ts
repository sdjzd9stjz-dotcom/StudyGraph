import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalJson, computeFingerprint, promptVersionOf } from '../src/fingerprint.ts'
import type { FingerprintInput } from '../src/fingerprint.ts'

const base: FingerprintInput = {
  upstreamArtifactHashes: ['aaa', 'bbb'],
  params: { maxChars: 800, overlap: 80 },
  modelVersion: 'gpt-4o-mini-2024-07-18',
  promptVersion: 'deadbeef1234',
}

const fingerprintOf = (patch: Partial<FingerprintInput>): string => computeFingerprint({ ...base, ...patch })

test('同一输入两次 → 同一指纹（否则缓存永远不命中）', () => {
  assert.equal(fingerprintOf({}), fingerprintOf({}))
})

test('上游 artifacts 变 → 指纹变', () => {
  assert.notEqual(fingerprintOf({ upstreamArtifactHashes: ['aaa', 'ccc'] }), fingerprintOf({}))
})

test('params 变 → 指纹变', () => {
  assert.notEqual(fingerprintOf({ params: { maxChars: 900, overlap: 80 } }), fingerprintOf({}))
})

test('modelVersion 变 → 指纹变（别名相同但真实模型不同也要失效）', () => {
  assert.notEqual(fingerprintOf({ modelVersion: 'gpt-4o-mini-2024-11-20' }), fingerprintOf({}))
})

test('promptVersion 变 → 指纹变（改了 prompt 一个字符就必须未命中）', () => {
  assert.notEqual(fingerprintOf({ promptVersion: promptVersionOf('另一段 prompt') }), fingerprintOf({}))
})

test('上游 hash 顺序不同但集合相同 → 同一指纹', () => {
  assert.equal(
    fingerprintOf({ upstreamArtifactHashes: ['bbb', 'aaa'] }),
    fingerprintOf({ upstreamArtifactHashes: ['aaa', 'bbb'] }),
  )
})

test('canonicalJson：键序不同、内容相同 → 同一字符串', () => {
  assert.equal(canonicalJson({ a: 1, b: { c: 2, d: 3 } }), canonicalJson({ b: { d: 3, c: 2 }, a: 1 }))
})

test('canonicalJson：数组顺序有意义，不许排序', () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]))
})

test('canonicalJson：丢弃 undefined，但保留 null', () => {
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}')
  assert.equal(canonicalJson({ a: null, b: 1 }), '{"a":null,"b":1}')
})

test('promptVersionOf 由 prompt 文本决定，12 位十六进制', () => {
  const v1 = promptVersionOf('请从下面这段话里抽取概念')
  assert.match(v1, /^[0-9a-f]{12}$/)
  assert.equal(promptVersionOf('请从下面这段话里抽取概念'), v1)

  // 只改一个字符
  const v2 = promptVersionOf('请从下面这段话里抽取概念。')
  assert.notEqual(v2, v1)
})
