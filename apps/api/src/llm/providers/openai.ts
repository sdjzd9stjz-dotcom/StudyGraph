import type { JSONSchema, Message, TokenUsage } from '../types.ts'
import { assertUsageAndModel } from './validate.ts'

export interface ProviderCall {
  readonly model: string
  readonly messages: readonly Message[]
  readonly jsonSchema?: JSONSchema
  readonly maxTokens?: number
  /** 前缀缓存键：必须真的影响出站请求（SG-SUP-005 缺陷 E） */
  readonly cachePrefixKey?: string
}

export interface ProviderResult {
  readonly data: unknown
  readonly usage: TokenUsage
  /** 厂商响应里的真实模型标识（不是请求里写的别名） */
  readonly modelVersion: string
}

export interface OpenAIProviderConfig {
  readonly apiKey: string
  readonly baseUrl?: string
  /** 便于测试注入 */
  readonly fetchImpl?: typeof fetch
}

/**
 * OpenAI Chat Completions 适配层。
 *
 * - 结构化输出用 `response_format: json_schema` 强制，不解析模型自由文本
 * - `usage` / `model` 缺失即抛 PROVIDER_RESPONSE_INVALID（见 providers/validate.ts）
 * - `cachePrefixKey` 落进 `prompt_cache_key`：前缀缓存按这个键路由，
 *   键不同 → 出站请求体不同（可观察）
 */
export function createOpenAIProvider(config: OpenAIProviderConfig) {
  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1'
  const doFetch = config.fetchImpl ?? fetch

  return async function call(input: ProviderCall): Promise<ProviderResult> {
    const body: Record<string, unknown> = {
      model: input.model,
      messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
      max_tokens: input.maxTokens ?? 2048,
    }

    if (input.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'studygraph_result', strict: true, schema: input.jsonSchema },
      }
    }

    if (input.cachePrefixKey) {
      // OpenAI 的前缀缓存按 prompt_cache_key 分组；同一段教材原文共享一个键
      body.prompt_cache_key = input.cachePrefixKey
    }

    const response = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      // 失败必须抛，不许返回空对象让上层当成功
      throw new Error(`OpenAI ${response.status}: ${text.slice(0, 400)}`)
    }

    const payload = (await response.json()) as {
      model?: unknown
      choices?: Array<{ message?: { content?: string } }>
      usage?: unknown
    }

    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('OpenAI 返回缺少 message.content')

    let data: unknown
    try {
      data = JSON.parse(content)
    } catch {
      throw new Error(`OpenAI 返回的内容不是合法 JSON：${content.slice(0, 200)}`)
    }

    const { modelVersion, usage } = assertUsageAndModel('openai', payload, (raw) => {
      const details = raw.prompt_tokens_details as { cached_tokens?: unknown } | undefined
      return {
        tokensIn: raw.prompt_tokens,
        tokensOut: raw.completion_tokens,
        cachedTokens: details?.cached_tokens,
      }
    })

    return { data, usage, modelVersion }
  }
}
