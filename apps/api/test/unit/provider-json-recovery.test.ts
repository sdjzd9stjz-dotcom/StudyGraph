import assert from 'node:assert/strict'
import test from 'node:test'

import { createOpenAICompatibleProvider } from '../../src/llm/providers/openai-compatible.ts'

/**
 * 输出被截断 / 不是裸 JSON 时的恢复。
 *
 * 真实事故（2026-11-21，用户的高代课件）：
 *   `deepseek 调用失败：openai 返回的内容不是合法 JSON：{"claims":[{"chunk":8,...
 *   `deepseek 调用失败：openai 返回的内容不是合法 JSON：`（后面是空的）
 *
 * 原因不是密钥、也不是 response_format —— 是 **max_tokens 用完了**。
 * DeepSeek 现在的 flash / v4-pro 都把思考 token 算进输出额度：
 * 2048 的预算里思考先吃掉一大半，剩下的 JSON 写到一半被切断，
 * 有的干脆一个字都没留下。默认值 2048 对任何"要列清单"的任务都太小。
 *
 * 三条恢复原则：
 *   1. 额度不够 → 加倍重试**一次**（不是无限重试，也不是直接判死）
 *   2. 模型爱加围栏、爱先说一句废话 → 解析时容忍，但绝不猜内容
 *   3. 截断的 JSON 不许"尽量解析" —— 半份定义比没有更危险
 */

const jsonSchema = {
  type: 'object',
  properties: { claims: { type: 'array', items: { type: 'object' } } },
  required: ['claims'],
} as const

const goodJson = '{"claims":[{"chunk":0,"name":"确界","definition":"确界是指……","quote":"……"}]}'

function usage() {
  return { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 0 }
}

function reply(content: string, finish = 'stop', reasoning = 0) {
  return Response.json({
    model: 'deepseek-flash',
    choices: [{ message: { content, ...(reasoning ? { reasoning_content: 'x'.repeat(reasoning) } : {}) }, finish_reason: finish }],
    usage: usage(),
  })
}

test('输出被截断（finish_reason=length）→ 用双倍额度重试一次并成功', async () => {
  const budgets: number[] = []
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { max_tokens: number }
    budgets.push(body.max_tokens)
    return budgets.length === 1
      ? reply('{"claims":[{"chunk":0,"name":"确界存在定理",', 'length')
      : reply(goodJson)
  }) as unknown as typeof fetch

  const call = createOpenAICompatibleProvider({
    provider: 'deepseek',
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com',
    fetchImpl: fakeFetch,
  })

  const result = await call({ model: 'deepseek-flash', messages: [], jsonSchema })

  assert.deepEqual(budgets, [4096, 8192], '默认额度要够用，截断后翻倍且只翻一次')
  assert.deepEqual(result.data, { claims: [{ chunk: 0, name: '确界', definition: '确界是指……', quote: '……' }] })
})

test('思考把额度烧光、content 为空 → 同样翻倍重试，而不是报"不是合法 JSON"', async () => {
  let calls = 0
  const fakeFetch = (async () => {
    calls += 1
    return calls === 1 ? reply('', 'length', 4000) : reply(goodJson)
  }) as unknown as typeof fetch

  const call = createOpenAICompatibleProvider({
    provider: 'deepseek',
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com',
    fetchImpl: fakeFetch,
  })

  const result = await call({ model: 'deepseek-v4-pro', messages: [], jsonSchema })
  assert.equal(calls, 2)
  assert.ok(Array.isArray((result.data as { claims: unknown[] }).claims))
})

test('重试后仍然截断 → 抛错，并说清是额度问题（不吞掉、不返回半份数据）', async () => {
  const fakeFetch = (async () => reply('{"claims":[{"chunk":0,"name":"确界', 'length')) as unknown as typeof fetch

  const call = createOpenAICompatibleProvider({
    provider: 'deepseek',
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com',
    fetchImpl: fakeFetch,
  })

  await assert.rejects(
    () => call({ model: 'deepseek-flash', messages: [], jsonSchema }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /截断|额度|max_tokens/)
      assert.doesNotMatch(message, /不是合法 JSON/)
      return true
    },
  )
})

test('模型套了 ```json 围栏 / 前面带一句话 → 取出对象，不因为包装层报错', async () => {
  const wrapped = '好的，以下是结果：\n```json\n' + goodJson + '\n```\n希望有帮助。'
  const fakeFetch = (async () => reply(wrapped)) as unknown as typeof fetch

  const call = createOpenAICompatibleProvider({
    provider: 'deepseek',
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com',
    fetchImpl: fakeFetch,
  })

  const result = await call({ model: 'deepseek-flash', messages: [], jsonSchema })
  assert.deepEqual(result.data, JSON.parse(goodJson))
})

test('json_schema 被拒 → 先降级成 json_object（DeepSeek 认这个），不是直接丢掉', async () => {
  const formats: unknown[] = []
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { response_format?: { type: string } }
    formats.push(body.response_format?.type ?? 'none')
    if (formats.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'This response_format type is unavailable now' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    return reply(goodJson)
  }) as unknown as typeof fetch

  const call = createOpenAICompatibleProvider({
    provider: 'openai',
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com',
    fetchImpl: fakeFetch,
  })

  await call({ model: 'deepseek-flash', messages: [], jsonSchema })
  assert.deepEqual(formats, ['json_schema', 'json_object'])
})

test('连 json_object 也被拒 → 最后完全去掉 response_format', async () => {
  const formats: unknown[] = []
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { response_format?: { type: string } }
    formats.push(body.response_format?.type ?? 'none')
    if (formats.length < 3) {
      return new Response(JSON.stringify({ error: { message: 'This response_format type is unavailable now' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    return reply(goodJson)
  }) as unknown as typeof fetch

  const call = createOpenAICompatibleProvider({
    provider: 'openai',
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com',
    fetchImpl: fakeFetch,
  })

  await call({ model: 'deepseek-flash', messages: [], jsonSchema })
  assert.deepEqual(formats, ['json_schema', 'json_object', 'none'])
})

test('调用方指定额度时按指定值用，不被默认值覆盖', async () => {
  let seen = 0
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    seen = (JSON.parse(String(init.body)) as { max_tokens: number }).max_tokens
    return reply(goodJson)
  }) as unknown as typeof fetch

  const call = createOpenAICompatibleProvider({
    provider: 'deepseek',
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com',
    fetchImpl: fakeFetch,
  })

  await call({ model: 'deepseek-flash', messages: [], jsonSchema, maxTokens: 2048 })
  assert.equal(seen, 2048)
})
