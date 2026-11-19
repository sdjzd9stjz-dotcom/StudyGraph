import assert from 'node:assert/strict'
import test from 'node:test'

import { AppError } from '../../src/lib/errors.ts'
import { decryptSecret, encryptSecret } from '../../src/llm/byok.ts'
import { createGateway } from '../../src/llm/gateway.ts'
import { TASK_ROUTING } from '../../src/llm/routing.ts'
import type { GatewayDeps } from '../../src/llm/gateway.ts'

const user = { id: 'u1', email: 'u@t.t', displayName: 'u' }

const gateway = (overrides: Partial<GatewayDeps> = {}) =>
  createGateway({
    resolveApiKey: async () => 'test-key',
    ...overrides,
  })

test('没有凭据 → 503 LLM_CREDENTIAL_MISSING（不是空对象，也不是 200）', async () => {
  const gw = gateway({ resolveApiKey: async () => null })

  await assert.rejects(
    () => gw.complete({ taskType: 'extract', messages: [{ role: 'user', content: 'hi' }], user }),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.status, 503)
      assert.equal(error.code, 'LLM_CREDENTIAL_MISSING')
      return true
    },
  )
})

test('厂商返回 401 → 502 LLM_PROVIDER_ERROR（失败必须抛）', async () => {
  const fakeFetch = (async () =>
    new Response('{"error":{"message":"invalid api key"}}', { status: 401 })) as typeof fetch
  const gw = gateway({ fetchImpl: fakeFetch })

  await assert.rejects(
    () => gw.complete({ taskType: 'extract', messages: [{ role: 'user', content: 'hi' }], user }),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.status, 502)
      assert.equal(error.code, 'LLM_PROVIDER_ERROR')
      return true
    },
  )
})

test('成功时 usage 与 modelVersion 取自厂商响应，不是本地配置', async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        model: 'gpt-4o-mini-2024-07-18',
        choices: [{ message: { content: '{"claims":[]}' } }],
        usage: { prompt_tokens: 123, completion_tokens: 45, prompt_tokens_details: { cached_tokens: 100 } },
      }),
      { status: 200 },
    )) as typeof fetch

  const gw = gateway({ fetchImpl: fakeFetch })
  const result = await gw.complete({
    taskType: 'extract',
    messages: [{ role: 'user', content: 'hi' }],
    user,
  })

  assert.deepEqual(result.usage, { tokensIn: 123, tokensOut: 45, cachedTokens: 100 })
  // 关键：modelVersion 是响应里的真实标识，不是路由表里的 'gpt-4o-mini' 别名
  assert.equal(result.modelVersion, 'gpt-4o-mini-2024-07-18')
})

test('routing 表：机械任务走小模型，推理任务走前沿模型', () => {
  for (const task of ['chunk', 'extract', 'judge', 'check', 'quiz'] as const) {
    assert.equal(TASK_ROUTING[task].tier, 'small', `${task} 应走小模型`)
  }
  for (const task of ['probe', 'method', 'solve', 'variant'] as const) {
    assert.equal(TASK_ROUTING[task].tier, 'frontier', `${task} 应走前沿模型`)
  }
  // 两个供应商都要被用上（首期两个 provider）
  const providers = new Set(Object.values(TASK_ROUTING).map((route) => route.provider))
  assert.deepEqual([...providers].sort(), ['anthropic', 'openai'])
})

test('BYOK：AES-256-GCM 加密后可解密，密文里没有明文', () => {
  const masterKey = Buffer.alloc(32, 7).toString('base64')
  const secret = 'sk-live-abcdefghijklmnop'

  const ciphertext = encryptSecret(secret, masterKey)
  assert.equal(ciphertext.includes(secret), false, '密文里不能出现明文')

  assert.equal(decryptSecret(ciphertext, masterKey), secret)
})

test('BYOK：密文被篡改 → 解密抛错（GCM tag 校验）', () => {
  const masterKey = Buffer.alloc(32, 7).toString('base64')
  const payload = JSON.parse(encryptSecret('sk-test', masterKey)) as { ciphertext: string }

  const tampered = Buffer.from(payload.ciphertext, 'base64')
  tampered[0] = tampered[0] ^ 0xff
  payload.ciphertext = tampered.toString('base64')

  assert.throws(() => decryptSecret(JSON.stringify(payload), masterKey))
})

test('BYOK：没有主密钥 → 拒绝加密（不退化成明文）', () => {
  assert.throws(() => encryptSecret('sk-test', ''), /BYOK_ENCRYPTION_KEY 未配置/)
  assert.throws(() => encryptSecret('sk-test', Buffer.alloc(16, 1).toString('base64')), /必须是 32 字节/)
})
