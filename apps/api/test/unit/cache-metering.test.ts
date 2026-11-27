import assert from 'node:assert/strict'
import test from 'node:test'
import { extractExecutor } from '../../src/nodes/executors/extract.ts'
import type { LLMCompleteRequest } from '../../src/llm/types.ts'
import { createGateway } from '../../src/llm/gateway.ts'
import { forwardMeteredStream, meteredUsage } from '../../src/llm/providers/cache-usage.ts'
import { anthropicMessagesUrl } from '../../src/llm/providers/anthropic.ts'

const counts = { prompt_tokens: 2000, completion_tokens: 7 }
const user = { id: 'u', email: 'test@example.invalid', displayName: '回归', canvasId: 'canvas' }
const target = { source: 'byok' as const, protocol: 'OPENAI' as const, apiKey: 'test', baseUrl: 'http://localhost/v1',
  model: 'alias', providerSlug: 'custom-test', providerName: '测试', fromPreference: true }

test('上游明确零命中、未上报、DeepSeek 自定义端点和 Anthropic 读写分别计量', () => {
  assert.equal(meteredUsage(counts).cacheUsageComplete, false)
  assert.deepEqual(meteredUsage({ ...counts, prompt_tokens_details: { cached_tokens: 0 } }),
    { tokensIn: 2000, tokensOut: 7, cachedTokens: 0, cacheUsageComplete: true })
  assert.equal(meteredUsage({ ...counts, prompt_cache_hit_tokens: 512 }).cachedTokens, 512)
  assert.deepEqual(meteredUsage({ input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 700, output_tokens: 7 }),
    { tokensIn: 1000, tokensOut: 7, cachedTokens: 700, cacheUsageComplete: true })
  assert.equal(meteredUsage({ ...counts, prompt_cache_hit_tokens: -1 }).cacheUsageComplete, false)
  for (const base of ['https://example.invalid', 'https://example.invalid/', 'https://example.invalid/v1/']) {
    assert.equal(anthropicMessagesUrl(base), 'https://example.invalid/v1/messages')
  }
})

test('逐字节转发流，合并 Anthropic 开始和结束帧，保留扩展字段及中文', async () => {
  const text = ['event: message_start', 'data: {"message":{"usage":{"input_tokens":4,"cache_creation_input_tokens":10,"cache_read_input_tokens":128}}}', '',
    'data: {"delta":{"text":"公式"}}', '', 'data: {"usage":{"output_tokens":12}}', '', 'data: [DONE]'].join('\r\n')
  const bytes = new TextEncoder().encode(text), writes: Uint8Array[] = []
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close() } })
  const usage = await forwardMeteredStream(new Response(stream), b => writes.push(b))
  assert.equal(Buffer.concat(writes).toString(), text)
  assert.deepEqual(usage, { tokensIn: 142, tokensOut: 12, cachedTokens: 128, cacheUsageComplete: true })
})

test('只配置自定义模型时，两个批次共享固定前缀，工具对话复用同一任务路由键', async () => {
  const seen = new Map<string, string>()
  const gw = createGateway({ resolveApiKey: async () => { throw Error('不应读取默认厂商密钥') },
    resolveTarget: async (_task, account) => { assert.equal(account.canvasId, 'canvas'); return target },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const prefix = JSON.stringify(body.messages.slice(0, -1)), key = body.prompt_cache_key
      assert.match(key, /^sg-[a-f0-9]{32}$/)
      if (!body.tools) assert.match(prefix, /JSON Schema/)
      const hit = seen.get(key) === prefix ? 1024 : 0
      seen.set(key, prefix)
      return Response.json({ model: 'snapshot', choices: [{ message: { content: '{}' } }], usage: { ...counts, prompt_cache_hit_tokens: hit } })
    } })
  for (const task of ['extract', 'assistant'] as const) {
    for (const [i, content] of ['甲', '乙'].entries()) {
      const messages = [{ role: 'system' as const, content: '固定指令' }, { role: 'user' as const, content }]
      const result = task === 'assistant' ? await gw.chatWithTools({ taskType: task, user, messages, tools: [] })
        : await gw.complete({ taskType: task, user, messages, jsonSchema: { type: 'object' } })
      assert.equal(result.usage.cachedTokens, i ? 1024 : 0)
      assert.equal(result.provider, 'custom-test')
    }
  }
  assert.equal(seen.size, 2)
})

test('只有端点明确拒绝缓存键时才移除它重试，普通调用和工具对话均可完成', async () => {
  for (const tool of [false, true]) {
    const sent: Record<string, unknown>[] = []
    const gw = createGateway({ resolveApiKey: async () => null, resolveTarget: async () => target, fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); sent.push(body)
      if (body.prompt_cache_key) return new Response('unsupported parameter prompt_cache_key', { status: 422 })
      return Response.json({ model: 'snapshot', choices: [{ message: { content: '{}' } }], usage: counts })
    } })
    const request = { taskType: 'assistant' as const, messages: [], user }
    const result = tool ? await gw.chatWithTools({ ...request, tools: [] }) : await gw.complete(request)
    const { prompt_cache_key, ...rest } = sent[0]!
    assert.ok(prompt_cache_key); assert.deepEqual(sent.slice(1), [rest]); assert.equal(result.usage.cacheUsageComplete, false)
  }
})


test('抽取先探测短提示，按上游读数选择或停止长前缀，始终每批一次调用', async () => {
  async function requests(hits: (number | null)[]) {
    const prompts: string[] = []
    const chunks = hits.map((_, i) => ({ text: '批次内容' + i, pageStart: i + 1, spanIds: ['s' + i] }))
    const ctx = { params: { batchSize: 1 }, inputs: { chunkSet: { sourceId: 'qa', chunks } }, skills: [], user,
      llm: { complete: async (r: LLMCompleteRequest) => {
        const index = prompts.length, hit = hits[index]!
        assert.ok(r.messages.at(-1)!.content.endsWith(chunks[index]!.text))
        prompts.push(r.messages[0]!.content)
        return { data: { claims: [] }, usage: { tokensIn: 2000, tokensOut: 1, cachedTokens: hit ?? 0, cacheUsageComplete: hit !== null }, provider: 'test', modelVersion: 'snapshot' }
      } } }
    await extractExecutor.run(ctx as never)
    assert.equal(prompts.length, hits.length)
    return prompts.map(s => s === prompts[0] ? '短' : '长').join('')
  }
  assert.equal(await requests([0, 0, 0, 0]), '短短短短')
  assert.equal(await requests([0, null, 0, 0, 0, 0]), '短短短短短短')
  assert.equal(await requests([0, 640, 640, 640, 640]), '短短短短短')
  assert.equal(await requests([0, 0, 0, 0, 64, 0, 0]), '短短长长长短短')
  assert.equal(await requests([0, 0, 0, 1024, 0, 1024, 1024]), '短短长长长长长')
  assert.equal(await requests([0, 0, 0, 1024, 0, null, 0]), '短短长长长长短')
})

test('节点和画布会话使用稳定隔离的路由键', async () => {
  const keys: string[] = []
  const gw = createGateway({ resolveApiKey: async () => null, resolveTarget: async () => target,
    fetchImpl: async (_, init) => {
      keys.push(JSON.parse(String(init?.body)).prompt_cache_key)
      return Response.json({ model: 'snapshot', choices: [{ message: { content: 'ok' } }], usage: counts })
    } })
  for (const conversationId of ['画布甲', '画布甲', '画布乙']) {
    await gw.chatWithTools({ user, taskType: 'assistant', conversationId, messages: [], tools: [] })
  }
  assert.equal(keys[0], keys[1]); assert.notEqual(keys[0], keys[2]); assert.match(keys[0]!, /^sg-[a-f0-9]{32}$/)
})
