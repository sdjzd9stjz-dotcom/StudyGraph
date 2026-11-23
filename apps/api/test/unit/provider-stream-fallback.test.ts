import assert from 'node:assert/strict'
import test from 'node:test'

import { createOpenAICompatibleAgent, createOpenAICompatibleProvider } from '../../src/llm/providers/openai-compatible.ts'

/**
 * 只接受流式的端点（校园网关 / 中转站）。
 *
 * 真实报错：
 *   openai 400: {"code":"stream_required","message":"This group only accepts streaming requests; set \"stream\": true"}
 * 这类端点不是坏了，是**协议只此一种**。要么支持流式，要么整台模型用不了。
 *
 * 三个必须守住的点：
 *   · 只在被明确拒绝时降级（默认不开流式，解析多一层就多一处出错）
 *   · 降级后 SSE 要能拼回完整的 content / tool_calls / usage
 *   · 拼出来的东西必须和"非流式响应"长得一样，下游逻辑一行都不用改
 */

const sse = (chunks: unknown[]) =>
  new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }

test('端点要求流式 → 加 stream 重发，并把 SSE 拼回文本', async () => {
  const payloads: Array<Record<string, unknown>> = []
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    payloads.push(body)
    if (!body.stream) {
      return new Response(
        JSON.stringify({ error: { code: 'stream_required', message: 'This group only accepts streaming requests; set "stream": true' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }
    return sse([
      { model: 'custom-model', choices: [{ delta: { content: '这是' } }] },
      { model: 'custom-model', choices: [{ delta: { content: '一段回答。' }, finish_reason: 'stop' }] },
      { model: 'custom-model', choices: [], usage },
    ])
  }) as unknown as typeof fetch

  const call = createOpenAICompatibleProvider({
    provider: 'openai',
    apiKey: 'k',
    baseUrl: 'https://gw.example.com/v1',
    fetchImpl: fakeFetch,
  })

  const result = await call({ model: 'custom-model', messages: [{ role: 'user', content: '你好' }] })

  assert.equal(payloads.length, 2)
  assert.equal(payloads[1]!.stream, true)
  assert.deepEqual(result.data, { text: '这是一段回答。' })
  assert.equal(result.modelVersion, 'custom-model')
  assert.deepEqual(result.usage, { tokensIn: 10, tokensOut: 5, cachedTokens: 0 })
})

test('流式下的 JSON 输出：chunk 拼接后再解析，不会因为分片解析失败', async () => {
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    if (!body.stream) {
      return new Response(JSON.stringify({ error: { message: 'stream_required', code: 'stream_required' } }), { status: 400 })
    }
    // 对象被切在两块里 —— 逐块解析必然失败，必须拼完再解析
    return sse([
      { model: 'm', choices: [{ delta: { content: '{"claims":[{"name":"上确界"' } }] },
      { model: 'm', choices: [{ delta: { content: '}]}' }, finish_reason: 'stop' }], usage },
    ])
  }) as unknown as typeof fetch

  const call = createOpenAICompatibleProvider({
    provider: 'openai',
    apiKey: 'k',
    baseUrl: 'https://gw.example.com/v1',
    fetchImpl: fakeFetch,
  })

  const result = await call({
    model: 'm',
    messages: [],
    jsonSchema: { type: 'object', properties: { claims: { type: 'array' } }, required: ['claims'] },
  })
  assert.deepEqual(result.data, { claims: [{ name: '上确界' }] })
})

test('流式下的工具调用：按 index 归组，arguments 逐段拼接', async () => {
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    if (!body.stream) {
      return new Response(JSON.stringify({ error: { code: 'stream_required', message: 'set "stream": true' } }), { status: 400 })
    }
    return sse([
      { model: 'm', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'create_node', arguments: '{"type"' } }] } }] },
      { model: 'm', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"CARD"}' } }] }, finish_reason: 'tool_calls' }], usage },
    ])
  }) as unknown as typeof fetch

  const agent = createOpenAICompatibleAgent({
    provider: 'openai',
    apiKey: 'k',
    baseUrl: 'https://gw.example.com/v1',
    fetchImpl: fakeFetch,
  })

  const result = await agent({ model: 'm', messages: [{ role: 'user', content: '建张卡' }], tools: [] })

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0]!.name, 'create_node')
  assert.equal(result.toolCalls[0]!.arguments, '{"type":"CARD"}')
  assert.equal(result.toolCalls[0]!.id, 'call_1')
})

test('不是 stream_required 的错误（如 401）不重发流式，原样抛错', async () => {
  let calls = 0
  const fakeFetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 })
  }) as unknown as typeof fetch

  const call = createOpenAICompatibleProvider({
    provider: 'openai',
    apiKey: 'bad',
    baseUrl: 'https://gw.example.com/v1',
    fetchImpl: fakeFetch,
  })

  await assert.rejects(() => call({ model: 'm', messages: [] }), /401/)
  assert.equal(calls, 1, '密钥错误重发流式没有意义')
})
