import assert from 'node:assert/strict'
import test from 'node:test'

import { createOpenAICompatibleProvider } from '../../src/llm/providers/openai-compatible.ts'

/**
 * `response_format` 被拒时的降级。
 *
 * 真实情况：DeepSeek 现在的模型直接返回
 * `400 This response_format type is unavailable now`。
 * 这不是配置错误，而是"同一个模型换了服务端版本" ——
 * 直接报错等于把一个本来能用的模型判死：模型明明会输出 JSON，
 * 只是不认这个参数。
 *
 * 所以：识别到是 `response_format` 的问题 → 去掉它重试一次。
 * 只重试一次，且必须确认第二次**不再带那个字段**，否则等于把同样的错误发两遍。
 */

const jsonSchema = {
  type: 'object',
  properties: { reply: { type: 'string' } },
  required: ['reply'],
  additionalProperties: false,
} as const

test('response_format 被拒 → 去掉它重试，并成功返回', async () => {
  const bodies: Array<Record<string, unknown>> = []

  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    bodies.push(body)
    if (bodies.length === 1) {
      return new Response(
        JSON.stringify({ error: { message: 'This response_format type is unavailable now' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }
    return Response.json({
      model: 'deepseek-flash',
      choices: [{ message: { content: '{"reply":"好的"}' } }],
      // usage 的字段是硬校验：缺 prompt_cache_hit_tokens 会被当成"响应非法"
      usage: { prompt_tokens: 12, completion_tokens: 3, prompt_cache_hit_tokens: 0 },
    })
  }) as unknown as typeof fetch

  const call = createOpenAICompatibleProvider({
    provider: 'deepseek',
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com',
    jsonMode: 'json_schema',
    fetchImpl: fakeFetch,
  })

  const result = await call({ model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }], jsonSchema })

  assert.equal(bodies.length, 2, '应该重试一次')
  assert.ok(bodies[0]!.response_format, '第一次要带 response_format')
  assert.deepEqual(bodies[1]!.response_format, { type: 'json_object' }, '第二步降级成 json_object（DeepSeek 认这个），不要一步丢光结构约束')
  assert.deepEqual(result.data, { reply: '好的' })

  // 没有 response_format 时，只能靠提示词要求 JSON —— 这条不能丢
  const retryMessages = bodies[1]!.messages as Array<{ role: string; content: string }>
  assert.ok(
    retryMessages.some((message) => /json/i.test(message.content)),
    '降级后的请求里必须明确要求输出 JSON，否则解析必然失败',
  )
})

test('不是 response_format 的问题 → 不重试，原样抛错', async () => {
  let calls = 0
  const fakeFetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  const call = createOpenAICompatibleProvider({
    provider: 'deepseek',
    apiKey: 'sk-bad',
    baseUrl: 'https://api.deepseek.com',
    fetchImpl: fakeFetch,
  })

  await assert.rejects(
    () => call({ model: 'deepseek-flash', messages: [], jsonSchema }),
    /401/,
  )
  assert.equal(calls, 1, '密钥错误重试没有意义，只会多花一次请求')
})
