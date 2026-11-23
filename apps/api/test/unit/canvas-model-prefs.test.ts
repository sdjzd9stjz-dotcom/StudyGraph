import assert from 'node:assert/strict'
import test from 'node:test'

import { createTargetResolver } from '../../src/llm/credentials.ts'
import { encryptSecret } from '../../src/llm/byok.ts'

/**
 * 画布级 AI 配置的**作用域**。
 *
 * 用户明确要求：「确定这些配置不会对全局生效，而是只针对该画布自身」。
 * 这条不能靠读代码下结论 —— 必须把"同一用户、两张画布、不同配置"摆在一起跑：
 *   · 画布 A 配了模型 → A 用 A 的
 *   · 画布 B 没配 → B 回落到全局
 *   · 没有 canvasId 的调用（比如全局页面）→ 仍然用全局
 * 任何一处串味，用户都会在两块画布之间看到模型互相污染。
 */

const masterKey = Buffer.alloc(32, 5).toString('base64')
const ciphertext = (secret: string) => encryptSecret(secret, masterKey)

const USER = { id: 'user-1', email: 'u@t.t', displayName: 'u' }
const DEFAULT_ROUTE = { provider: 'deepseek', model: 'deepseek-flash' }

/** 一个最小的内存版 Prisma：只覆盖 resolver 会查的那几张表 */
function makePrisma(input: {
  globalPref?: { taskType: string; modelId: string; apiKey: string }
  canvasPrefs?: Array<{ canvasId: string; taskType: string; modelId: string; apiKey: string }>
}) {
  const providers = [
    { id: 'prov-deepseek', slug: 'deepseek', name: 'DeepSeek', protocol: 'OPENAI', baseUrl: 'https://api.deepseek.com' },
    { id: 'prov-openai', slug: 'openai', name: 'OpenAI', protocol: 'OPENAI', baseUrl: 'https://api.openai.com/v1' },
  ]

  const credential = (id: string, providerId: string, apiKey: string) => ({
    id,
    providerId,
    ciphertext: ciphertext(apiKey),
    isActive: true,
    baseUrlOverride: null,
    provider: providers.find((provider) => provider.id === providerId)!,
  })

  const globalCredential = credential('cred-global', 'prov-openai', input.globalPref?.apiKey ?? 'sk-global')
  const canvasCredentials = (input.canvasPrefs ?? []).map((pref, index) =>
    credential(`cred-canvas-${index}`, 'prov-deepseek', pref.apiKey),
  )

  return {
    provider: {
      findUnique: async ({ where }: { where: { slug: string } }) =>
        providers.find((provider) => provider.slug === where.slug) ?? null,
    },
    userModelPref: {
      findUnique: async ({ where }: { where: { userId_taskType: { userId: string; taskType: string } } }) => {
        const pref = input.globalPref
        if (!pref || pref.taskType !== where.userId_taskType.taskType) return null
        return { modelId: pref.modelId, credential: globalCredential }
      },
    },
    canvasModelPref: {
      findUnique: async ({
        where,
      }: {
        where: { canvasId_taskType: { canvasId: string; taskType: string } }
      }) => {
        const key = where.canvasId_taskType
        const index = (input.canvasPrefs ?? []).findIndex(
          (pref) => pref.canvasId === key.canvasId && pref.taskType === key.taskType,
        )
        if (index < 0) return null
        const pref = input.canvasPrefs![index]!
        return { modelId: pref.modelId, credential: canvasCredentials[index]! }
      },
    },
    userCredential: {
      findFirst: async ({ where }: { where: { providerId: string } }) =>
        where.providerId === 'prov-openai' ? globalCredential : null,
    },
  } as never
}

const makeResolver = (prisma: unknown) =>
  createTargetResolver({ prisma: prisma as never, masterKey, env: {} })

test('画布自己配了模型 → 用画布的，不碰全局', async () => {
  const resolve = makeResolver(
    makePrisma({
      globalPref: { taskType: 'assistant', modelId: 'gpt-4o-mini', apiKey: 'sk-global' },
      canvasPrefs: [{ canvasId: 'canvas-a', taskType: 'assistant', modelId: 'deepseek-v4-pro', apiKey: 'sk-canvas-a' }],
    }),
  )

  const target = await resolve('assistant', { ...USER, canvasId: 'canvas-a' }, DEFAULT_ROUTE)
  assert.equal(target?.model, 'deepseek-v4-pro')
  assert.equal(target?.apiKey, 'sk-canvas-a', '必须是这块画布自己的密钥')
})

test('另一块画布没配 → 回落到全局，不受 A 的影响', async () => {
  const resolve = makeResolver(
    makePrisma({
      globalPref: { taskType: 'assistant', modelId: 'gpt-4o-mini', apiKey: 'sk-global' },
      canvasPrefs: [{ canvasId: 'canvas-a', taskType: 'assistant', modelId: 'deepseek-v4-pro', apiKey: 'sk-canvas-a' }],
    }),
  )

  const a = await resolve('assistant', { ...USER, canvasId: 'canvas-a' }, DEFAULT_ROUTE)
  const b = await resolve('assistant', { ...USER, canvasId: 'canvas-b' }, DEFAULT_ROUTE)

  assert.equal(a?.model, 'deepseek-v4-pro')
  assert.equal(b?.model, 'gpt-4o-mini', 'B 必须回落到全局，不能串用 A 的配置')
  assert.notEqual(a?.apiKey, b?.apiKey)
})

test('没有 canvasId 的调用（全局页面）→ 忽略一切画布配置', async () => {
  const resolve = makeResolver(
    makePrisma({
      globalPref: { taskType: 'assistant', modelId: 'gpt-4o-mini', apiKey: 'sk-global' },
      canvasPrefs: [{ canvasId: 'canvas-a', taskType: 'assistant', modelId: 'deepseek-v4-pro', apiKey: 'sk-canvas-a' }],
    }),
  )

  const target = await resolve('assistant', USER, DEFAULT_ROUTE)
  assert.equal(target?.model, 'gpt-4o-mini')
  assert.equal(target?.apiKey, 'sk-global')
})

test('画布只配了对话，别的任务仍然走全局', async () => {
  const resolve = makeResolver(
    makePrisma({
      globalPref: { taskType: 'quiz', modelId: 'gpt-4o-mini', apiKey: 'sk-global' },
      canvasPrefs: [{ canvasId: 'canvas-a', taskType: 'assistant', modelId: 'deepseek-v4-pro', apiKey: 'sk-canvas-a' }],
    }),
  )

  const quiz = await resolve('quiz', { ...USER, canvasId: 'canvas-a' }, DEFAULT_ROUTE)
  // quiz 没在这块画布上配过 → 用全局那条（gpt-4o-mini），而不是画布 A 的对话模型
  assert.equal(quiz?.model, 'gpt-4o-mini')
  assert.notEqual(quiz?.model, 'deepseek-v4-pro', '绝不能串用画布 A 的对话模型')
})
