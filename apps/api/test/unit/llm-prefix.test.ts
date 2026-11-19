import assert from 'node:assert/strict'
import test from 'node:test'

import { createGateway } from '../../src/llm/gateway.ts'
import { createAnthropicProvider } from '../../src/llm/providers/anthropic.ts'
import { createOpenAIProvider } from '../../src/llm/providers/openai.ts'

/**
 * 前缀缓存的标准（SG-SUP-006 §3.3）：
 *   1. 前缀材料变化 → 请求体必须变化
 *   2. 前缀材料相同 → 请求体必须相同
 *   3. 各厂商的机制证据（OpenAI 的 key、Anthropic 的 text + cache_control）
 */

const PREFIX_A = { key: 'source:a:ch1:v1', text: '第一讲的原文' }
const PREFIX_A2 = { key: 'source:a:ch1:v1', text: '第一讲的原文' }
const PREFIX_B = { key: 'source:a:ch2:v1', text: '第二讲的原文' }

function openAIBodies() {
  const bodies: string[] = []
  const call = createOpenAIProvider({
    apiKey: 'test',
    fetchImpl: (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return Response.json({
        choices: [{ message: { content: '{}' } }],
        model: 'snap-1',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    }) as unknown as typeof fetch,
  })
  return { bodies, call }
}

function anthropicBodies() {
  const bodies: string[] = []
  const call = createAnthropicProvider({
    apiKey: 'test',
    fetchImpl: (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return Response.json({
        content: [{ type: 'text', text: '{}' }],
        model: 'snap-1',
        usage: { input_tokens: 3, output_tokens: 1 },
      })
    }) as unknown as typeof fetch,
  })
  return { bodies, call }
}

test('标准 1+2（OpenAI）：材料变则请求体变，材料同则请求体同', async () => {
  const { bodies, call } = openAIBodies()
  for (const prefix of [PREFIX_A, PREFIX_A2, PREFIX_B]) {
    await call({ model: 'alias', messages: [{ role: 'user', content: 'q' }], cachePrefix: prefix })
  }
  assert.equal(bodies[0], bodies[1], '同样的前缀材料必须产生完全相同的请求体')
  assert.notEqual(bodies[0], bodies[2], '换了章节原文，请求体必须不同')
})

test('标准 3（OpenAI）：key 进 prompt_cache_key，text 进 system', async () => {
  const { bodies, call } = openAIBodies()
  await call({ model: 'alias', messages: [{ role: 'user', content: 'q' }], cachePrefix: PREFIX_A })

  const body = JSON.parse(bodies[0] ?? '{}') as {
    prompt_cache_key?: string
    messages?: Array<{ role: string; content: string }>
  }
  assert.equal(body.prompt_cache_key, PREFIX_A.key)
  assert.equal(body.messages?.[0]?.role, 'system')
  assert.equal(body.messages?.[0]?.content, PREFIX_A.text)
})

test('标准 1+2（Anthropic）：材料变则请求体变，材料同则请求体同', async () => {
  const { bodies, call } = anthropicBodies()
  for (const prefix of [PREFIX_A, PREFIX_A2, PREFIX_B]) {
    await call({ model: 'alias', messages: [{ role: 'system', content: 'lesson' }], cachePrefix: prefix })
  }
  assert.equal(bodies[0], bodies[1])
  assert.notEqual(bodies[0], bodies[2])
})

test('标准 3（Anthropic）：text 进 system，最后一个块带 cache_control', async () => {
  const { bodies, call } = anthropicBodies()
  await call({ model: 'alias', messages: [{ role: 'system', content: 'lesson' }], cachePrefix: PREFIX_A })

  const body = JSON.parse(bodies[0] ?? '{}') as {
    system?: Array<{ type: string; text: string; cache_control?: { type: string } }>
  }
  assert.ok(body.system && body.system.length >= 2)
  assert.equal(body.system?.[0]?.text, PREFIX_A.text)
  const last = body.system[body.system.length - 1]
  assert.deepEqual(last?.cache_control, { type: 'ephemeral' })
})

test('Anthropic 的 key 不是死参数：gateway 会把它写进结构化日志', async () => {
  const logged: unknown[] = []
  const bodies: string[] = []
  const gateway = createGateway({
    resolveApiKey: async () => 'test',
    logger: { debug: (obj: unknown) => logged.push(obj) },
    fetchImpl: (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return Response.json({
        content: [{ type: 'text', text: '{}' }],
        model: 'snap-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }) as unknown as typeof fetch,
  })

  await gateway.complete({
    taskType: 'method',
    messages: [{ role: 'system', content: 'lesson' }],
    user: { id: 'u', email: 'u@t.t', displayName: 'u' },
    cachePrefix: PREFIX_A,
  })

  assert.equal(logged.length, 1)
  const entry = logged[0] as { cachePrefixKey?: string; provider?: string; prefixChars?: number }
  assert.equal(entry.cachePrefixKey, PREFIX_A.key)
  assert.equal(entry.provider, 'anthropic')
  assert.equal(entry.prefixChars, PREFIX_A.text.length)
  assert.equal(bodies.length, 1)
})

test('旧调用方只给 cachePrefixKey 也能工作（key 进 OpenAI 的缓存字段）', async () => {
  const { bodies, call } = openAIBodies()
  await call({ model: 'alias', messages: [{ role: 'user', content: 'q' }], cachePrefix: { key: 'legacy:1', text: '' } })
  const body = JSON.parse(bodies[0] ?? '{}') as { prompt_cache_key?: string }
  assert.equal(body.prompt_cache_key, 'legacy:1')
})
