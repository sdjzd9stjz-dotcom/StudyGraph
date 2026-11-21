import assert from 'node:assert/strict'
import test from 'node:test'

import { AppError } from '../../src/lib/errors.ts'
import { decryptSecret, encryptSecret } from '../../src/llm/byok.ts'
import { createApiKeyResolver } from '../../src/llm/credentials.ts'
import { createGateway } from '../../src/llm/gateway.ts'
import type { GatewayDeps } from '../../src/llm/gateway.ts'
import { ANTHROPIC_FRONTIER_ROUTE, OPENAI_SMALL_ROUTE, TASK_ROUTING } from '../../src/llm/routing.ts'

const user = { id: 'u1', email: 'u@t.t', displayName: 'u' }

test('DeepSeek 要求缓存计量，合法零值和命中数均按响应返回', async () => {
  for (const hit of [undefined, 0, 128]) {
    const gw = createGateway({
      resolveApiKey: async () => 'test',
      fetchImpl: async () => Response.json({
        model: 'snapshot', choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 150, completion_tokens: 1, prompt_cache_hit_tokens: hit },
      }),
    })
    const call = () => gw.complete({ taskType: 'extract', messages: [], user })
    if (hit === undefined) {
      await assert.rejects(call, (e: unknown) => e instanceof AppError && e.code === 'PROVIDER_RESPONSE_INVALID')
    } else {
      const result = await call()
      assert.equal(result.provider, 'deepseek')
      assert.equal(result.usage.cachedTokens, hit)
    }
  }
})

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

  const gw = gateway({
    fetchImpl: fakeFetch,
    // 显式指定路由，让这条测试只验"usage/modelVersion 取自响应"，不依赖全局路由表
    routing: { ...TASK_ROUTING, extract: { provider: 'openai', model: 'gpt-4o-mini', tier: 'small' } },
  })
  const result = await gw.complete({
    taskType: 'extract',
    messages: [{ role: 'user', content: 'hi' }],
    user,
  })

  assert.deepEqual(result.usage, { tokensIn: 123, tokensOut: 45, cachedTokens: 100 })
  // 关键：modelVersion 是响应里的真实标识，不是路由表里的 'gpt-4o-mini' 别名
  assert.equal(result.modelVersion, 'gpt-4o-mini-2024-07-18')
})

test('D：响应缺 usage/model → PROVIDER_RESPONSE_INVALID（openai，E06 第一行）', async () => {
  const fakeFetch = (async () =>
    Response.json({ choices: [{ message: { content: '{}' } }] })) as typeof fetch

  await assert.rejects(
    () => gateway({ fetchImpl: fakeFetch }).complete({ taskType: 'extract', messages: [], user }),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'PROVIDER_RESPONSE_INVALID')
      assert.deepEqual(error.details?.missing, ['model', 'usage'])
      return true
    },
  )
})

test('D：响应缺 usage/model → PROVIDER_RESPONSE_INVALID（anthropic，E06 第二行）', async () => {
  const fakeFetch = (async () =>
    Response.json({ content: [{ type: 'tool_use', input: {} }] })) as typeof fetch

  await assert.rejects(
    () =>
      gateway({
        fetchImpl: fakeFetch,
        routing: { ...TASK_ROUTING, method: { provider: 'anthropic', model: 'claude-sonnet-4-5', tier: 'frontier' } },
      }).complete({ taskType: 'method', messages: [], user }),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'PROVIDER_RESPONSE_INVALID')
      assert.deepEqual(error.details?.missing, ['model', 'usage'])
      return true
    },
  )
})

test('D：usage 存在但缺 tokensIn → 同样拒绝（"字段不存在"≠"值为 0"）', async () => {
  const fakeFetch = (async () =>
    Response.json({
      model: 'gpt-4o-mini-2024-07-18',
      choices: [{ message: { content: '{}' } }],
      usage: { completion_tokens: 10, prompt_cache_hit_tokens: 0 },
    })) as typeof fetch

  await assert.rejects(
    () => gateway({ fetchImpl: fakeFetch }).complete({ taskType: 'extract', messages: [], user }),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'PROVIDER_RESPONSE_INVALID')
      assert.deepEqual(error.details?.missing, ['usage.tokensIn'])
      return true
    },
  )
})

test('E：cachePrefixKey 必须影响出站请求体（E09）', async () => {
  const bodies: string[] = []
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body))
    return Response.json({
      model: 'snapshot-1',
      choices: [{ message: { content: '{}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
  }) as unknown as typeof fetch

  const gw = gateway({
    fetchImpl: fakeFetch,
    // 这条验的是 OpenAI 的 prompt_cache_key，显式把 extract 指回 openai
    routing: { ...TASK_ROUTING, extract: { provider: 'openai', model: 'gpt-4o-mini', tier: 'small' } },
  })
  for (const key of ['source:1:v1', 'source:1:v2']) {
    await gw.complete({ taskType: 'extract', messages: [], user, cachePrefixKey: key })
  }

  assert.equal(bodies.length, 2)
  assert.notEqual(bodies[0], bodies[1], '两个不同的前缀键必须产生不同的出站请求体')
  assert.match(bodies[0] ?? '', /source:1:v1/)
  assert.match(bodies[1] ?? '', /source:1:v2/)
})

test('E：BYOK 两个用户取到不同密钥，且第二个回退到 env', async () => {
  const masterKey = Buffer.alloc(32, 9).toString('base64')

  /**
   * 凭据现在存在 `UserCredential`（界面写入的那张表），
   * 按 `Provider.slug` 找 provider，再按 providerId + userId 找凭据。
   * 用旧表 `ProviderCredential` 的话，用户明明保存了密钥也会报"没有可用凭据"。
   */
  const prisma = {
    provider: {
      findUnique: async ({ where }: { where: { slug: string } }) =>
        where.slug === 'openai' ? { id: 'prov_openai' } : null,
    },
    userCredential: {
      findFirst: async ({ where }: { where: { userId: string } }) =>
        where.userId === 'user-a'
          ? { ciphertext: encryptSecret('sk-user-a', masterKey), isActive: true }
          : null,
    },
  }

  const resolve = createApiKeyResolver({
    prisma: prisma as never,
    masterKey,
    env: { OPENAI_API_KEY: 'sk-from-env' },
  })

  const a = await resolve('openai', { id: 'user-a', email: 'a@t.t', displayName: 'a' })
  const b = await resolve('openai', { id: 'user-b', email: 'b@t.t', displayName: 'b' })

  assert.deepEqual(a, { apiKey: 'sk-user-a', source: 'byok' })
  assert.deepEqual(b, { apiKey: 'sk-from-env', source: 'env' })
  assert.notEqual((a as { apiKey: string }).apiKey, (b as { apiKey: string }).apiKey)
})

test('E：有密文但没有主密钥 → 报错，不悄悄回退 env', async () => {
  const prisma = {
    provider: { findUnique: async () => ({ id: 'prov_openai' }) },
    userCredential: { findFirst: async () => ({ ciphertext: '{"v":1}', isActive: true }) },
  }
  const resolve = createApiKeyResolver({
    prisma: prisma as never,
    masterKey: undefined,
    env: { OPENAI_API_KEY: 'sk-from-env' },
  })

  await assert.rejects(
    () => resolve('openai', { id: 'user-a', email: 'a@t.t', displayName: 'a' }),
    /BYOK_ENCRYPTION_KEY 未配置/,
  )
})

test('routing 表：机械任务走小模型，推理任务走前沿模型', () => {
  for (const task of ['chunk', 'extract', 'judge', 'check', 'quiz'] as const) {
    assert.equal(TASK_ROUTING[task].tier, 'small', `${task} 应走小模型`)
  }
  for (const task of ['probe', 'method', 'solve', 'variant'] as const) {
    assert.equal(TASK_ROUTING[task].tier, 'frontier', `${task} 应走前沿模型`)
  }
  const providers = new Set(Object.values(TASK_ROUTING).map((route) => route.provider))
  // SG-SUP-009：M2 实调走 DeepSeek；OpenAI / Anthropic 的显式路由作为可选路径保留
  assert.deepEqual([...providers].sort(), ['deepseek'])
  assert.equal(OPENAI_SMALL_ROUTE.provider, 'openai')
  assert.equal(ANTHROPIC_FRONTIER_ROUTE.provider, 'anthropic')
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
  tampered[0] = (tampered[0] ?? 0) ^ 0xff
  payload.ciphertext = tampered.toString('base64')

  assert.throws(() => decryptSecret(JSON.stringify(payload), masterKey))
})

test('BYOK：没有主密钥 → 拒绝加密（不退化成明文）', () => {
  assert.throws(() => encryptSecret('sk-test', ''), /BYOK_ENCRYPTION_KEY 未配置/)
  assert.throws(() => encryptSecret('sk-test', Buffer.alloc(16, 1).toString('base64')), /必须是 32 字节/)
})
