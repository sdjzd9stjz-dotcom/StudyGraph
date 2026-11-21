import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { decryptSecret } from '../llm/byok.ts'
import type { TargetResolver } from '../llm/credentials.ts'
import type { UserCtx } from '../llm/user.ts'
import { AppError } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'
import { TASK_ROUTING } from '../llm/routing.ts'

/**
 * H1 · 兼容网关（M4.5）。
 *
 * 让第三方客户端把本服务当模型端点用，复用同一套路由、计量与前缀缓存。
 *
 * 四条约束：
 *   1. **调用方不得指定 baseUrl 或 apiKey** —— 只能选模型名，凭据由服务端解析。
 *      这条在实现上就是：请求体里的 apiKey/baseUrl 字段直接丢弃，不报错也不使用。
 *   2. 计量写 UsageRecord；归属按 credentialId（为空即平台承担）。
 *   3. 不得绕过任何硬约束 —— 本层只做协议翻译，不碰知识状态。
 *   4. PAT + run:execute 鉴权，与画布 API 同一套。
 */

const chatBody = z.object({
  model: z.string().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })).min(1),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().max(32000).optional(),
  temperature: z.number().optional(),
  // 明确接受但**忽略**：规格要求调用方不能指定凭据与端点
  apiKey: z.unknown().optional(),
  api_key: z.unknown().optional(),
  baseUrl: z.unknown().optional(),
  base_url: z.unknown().optional(),
})

const messagesBody = z.object({
  model: z.string().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })).min(1),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().max(32000).optional(),
})

const embeddingsBody = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(z.string())]),
})

/** 把 Anthropic 的 content 数组（[{type:'text',text}]）拍平成纯文本 */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text)
        return ''
      })
      .join('')
  }
  return ''
}

export interface CompatRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
  readonly resolveTarget: TargetResolver
  /** BYOK 主密钥；缺了就不能解密用户凭据，按模型名选路会直接失败 */
  readonly masterKey?: string | undefined
}

export function registerCompatRoutes(app: FastifyInstance, deps: CompatRouteDeps): void {
  const { prisma, guard, resolveTarget } = deps
  const masterKey = deps.masterKey ?? ''

  /**
   * 按模型名找凭据。找不到就回落到默认路由。
   * 这是"调用方只能选模型名"的落点：模型名 → 用户自己的凭据 → 端点与密钥都由服务端决定。
   */
  async function pickTarget(user: UserCtx, modelName: string | undefined) {
    if (modelName) {
      const credential = await prisma.userCredential.findFirst({
        where: { userId: user.id, isActive: true, provider: { models: { some: { modelId: modelName, enabled: true } } } },
        include: { provider: true },
        orderBy: { createdAt: 'desc' },
      })
      if (credential) {
        return {
          // 主密钥由 app.ts 注入，不读 process.env（测试环境里会漏）
          apiKey: decryptSecret(credential.ciphertext, masterKey),
          protocol: credential.provider.protocol as 'OPENAI' | 'ANTHROPIC' | 'GEMINI',
          baseUrl: credential.baseUrlOverride ?? credential.provider.baseUrl,
          model: modelName,
          providerSlug: credential.provider.slug,
          credentialId: credential.id,
        }
      }
    }
    const fallback = await resolveTarget('extract', user, TASK_ROUTING.extract)
    if (!fallback) return null
    return { ...fallback, credentialId: null as string | null }
  }

  /** `GET /v1/models`：当前路由表实际可用的模型，不含任何凭据信息。 */
  app.get('/v1/models', { preHandler: guard('RUN_EXECUTE') }, async (request) => {
    const auth = getAuth(request)
    const credentials = await prisma.userCredential.findMany({
      where: { userId: auth.user.id, isActive: true },
      select: { provider: { select: { models: { where: { enabled: true }, select: { modelId: true } } } } },
    })

    const fromCredentials = credentials.flatMap((c) => c.provider.models.map((m) => m.modelId))
    // 路由表里配的模型也算"可用"（平台额度场景）
    const fromRouting = Object.values(TASK_ROUTING).map((route) => route.model)
    const models = [...new Set([...fromCredentials, ...fromRouting])].sort()

    return {
      object: 'list',
      data: models.map((id) => ({ id, object: 'model', owned_by: 'studygraph' })),
    }
  })

  /**
   * `POST /v1/chat/completions`（OpenAI 兼容，含 SSE 流式）。
   *
   * 流式是**原样转发**上游的 SSE，只在最后一片里解析 usage 记账 ——
   * 自己重新拼 chunk 极易把 vendor 的扩展字段弄丢，客户端就解析不了。
   */
  app.post('/v1/chat/completions', { preHandler: guard('RUN_EXECUTE') }, async (request, reply) => {
    const auth = getAuth(request)
    const body = parse(chatBody, request.body)
    const target = await pickTarget(auth.user, body.model)
    if (!target) throw new AppError(400, 'NO_MODEL_CONFIGURED', '没有可用的模型，请先在设置里配置供应商密钥')

    const messages = body.messages.map((m) => ({ role: m.role, content: flattenContent(m.content) }))
    const upstreamBody: Record<string, unknown> = {
      model: target.model,
      messages,
      ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    }

    const headers: Record<string, string> =
      target.protocol === 'ANTHROPIC'
        ? { 'content-type': 'application/json', 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01' }
        : { 'content-type': 'application/json', authorization: `Bearer ${target.apiKey}` }

    const endpoint = target.protocol === 'ANTHROPIC' ? `${target.baseUrl}/v1/messages` : `${target.baseUrl}/chat/completions`
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(upstreamBody) })

    if (!response.ok) {
      const text = await response.text()
      throw new AppError(502, 'LLM_PROVIDER_ERROR', `上游返回 ${response.status}：${text.slice(0, 300)}`, { provider: target.providerSlug })
    }

    if (!body.stream) {
      const payload = (await response.json()) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number }
        [key: string]: unknown
      }
      await prisma.usageRecord.create({
        data: {
          userId: auth.user.id,
          surface: 'CHAT_COMPLETIONS',
          provider: target.providerSlug,
          model: target.model,
          tokensIn: payload.usage?.prompt_tokens ?? 0,
          tokensOut: payload.usage?.completion_tokens ?? 0,
          cachedTokens: 0,
        },
      })
      return reply.status(200).send(payload)
    }

    // 流式：逐块转发，同时记住最后看到的 usage
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const reader = response.body?.getReader()
    if (!reader) {
      res.end()
      return
    }
    const decoder = new TextDecoder()
    let usage = { tokensIn: 0, tokensOut: 0 }
    let tail = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      res.write(text)
      tail += text
      // 只在最后一段里找 usage，避免每块都做一次正则
      if (tail.length > 4000) tail = tail.slice(-4000)
      const match = /"usage"\s*:\s*\{[^}]*\}/.exec(tail)
      if (match) {
        const inMatch = /"prompt_tokens"\s*:\s*(\d+)/.exec(match[0])
        const outMatch = /"completion_tokens"\s*:\s*(\d+)/.exec(match[0])
        if (inMatch) usage.tokensIn = Number(inMatch[1])
        if (outMatch) usage.tokensOut = Number(outMatch[1])
      }
    }
    res.end()

    await prisma.usageRecord
      .create({
        data: {
          userId: auth.user.id,
          surface: 'CHAT_COMPLETIONS',
          provider: target.providerSlug,
          model: target.model,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          cachedTokens: 0,
        },
      })
      .catch(() => undefined)
  })

  /** `POST /v1/messages`：Anthropic 兼容。 */
  app.post('/v1/messages', { preHandler: guard('RUN_EXECUTE') }, async (request, reply) => {
    const auth = getAuth(request)
    const body = parse(messagesBody, request.body)
    const target = await pickTarget(auth.user, body.model)
    if (!target) throw new AppError(400, 'NO_MODEL_CONFIGURED', '没有可用的模型，请先在设置里配置供应商密钥')

    const system = body.messages
      .filter((m) => m.role === 'system')
      .map((m) => flattenContent(m.content))
      .join('\n')
    const messages = body.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: flattenContent(m.content) }))

    const upstreamBody: Record<string, unknown> = {
      model: target.model,
      max_tokens: body.max_tokens ?? 2048,
      messages,
      ...(system ? { system } : {}),
      ...(body.stream ? { stream: true } : {}),
    }

    const headers: Record<string, string> =
      target.protocol === 'ANTHROPIC'
        ? { 'content-type': 'application/json', 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01' }
        : { 'content-type': 'application/json', authorization: `Bearer ${target.apiKey}` }

    const endpoint = target.protocol === 'ANTHROPIC' ? `${target.baseUrl}/v1/messages` : `${target.baseUrl}/chat/completions`
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(upstreamBody) })

    if (!response.ok) {
      const text = await response.text()
      throw new AppError(502, 'LLM_PROVIDER_ERROR', `上游返回 ${response.status}：${text.slice(0, 300)}`, { provider: target.providerSlug })
    }

    if (!body.stream) {
      const payload = (await response.json()) as { usage?: Record<string, number>; [key: string]: unknown }
      await prisma.usageRecord.create({
        data: {
          userId: auth.user.id,
          surface: 'CHAT_COMPLETIONS',
          provider: target.providerSlug,
          model: target.model,
          tokensIn: payload.usage?.input_tokens ?? payload.usage?.prompt_tokens ?? 0,
          tokensOut: payload.usage?.output_tokens ?? payload.usage?.completion_tokens ?? 0,
          cachedTokens: 0,
        },
      })
      return reply.status(200).send(payload)
    }

    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const reader = response.body?.getReader()
    if (reader) {
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(decoder.decode(value, { stream: true }))
      }
    }
    res.end()
  })

  /**
   * `POST /v1/embeddings`：走同一解析链。
   *
   * 注意：向量维度取决于模型（`Concept.embedding` 定的是 1536），
   * 换模型会让已有向量与新向量不可比 —— 所以这里把维度变化显式告诉调用方。
   */
  app.post('/v1/embeddings', { preHandler: guard('RUN_EXECUTE') }, async (request) => {
    const auth = getAuth(request)
    const body = parse(embeddingsBody, request.body)
    const target = await pickTarget(auth.user, body.model)
    if (!target) throw new AppError(400, 'NO_MODEL_CONFIGURED', '没有可用的模型，请先在设置里配置供应商密钥')

    const response = await fetch(`${target.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${target.apiKey}` },
      body: JSON.stringify({ model: target.model, input: body.input }),
    })
    if (!response.ok) {
      const text = await response.text()
      throw new AppError(502, 'LLM_PROVIDER_ERROR', `上游返回 ${response.status}：${text.slice(0, 300)}`, { provider: target.providerSlug })
    }

    const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }>; usage?: { prompt_tokens?: number } }
    await prisma.usageRecord.create({
      data: {
        userId: auth.user.id,
        surface: 'CHAT_COMPLETIONS',
        provider: target.providerSlug,
        model: target.model,
        tokensIn: payload.usage?.prompt_tokens ?? 0,
        tokensOut: 0,
        cachedTokens: 0,
      },
    })

    const dimension = payload.data?.[0]?.embedding?.length
    return {
      ...payload,
      // 维度与库里的 vector(1536) 不一致时，调用方必须知道
      studygraph: { model: target.model, dimension, expectedDimension: 1536 },
    }
  })
}
