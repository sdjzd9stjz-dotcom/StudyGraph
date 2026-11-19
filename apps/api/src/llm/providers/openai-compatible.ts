import type { CachePrefix, JSONSchema, Message, TokenUsage } from '../types.ts'
import { assertUsageAndModel } from './validate.ts'

/**
 * OpenAI 兼容协议（Chat Completions）的共用实现。
 *
 * OpenAI 与 DeepSeek 走同一套协议，**只参数化差异**：
 * base URL、`response_format` 形态、usage 字段名。
 * 不复制一份 openai.ts 改域名——那样以后修 OpenAI 的 bug 不会同步到 DeepSeek。
 */

export interface ProviderCall {
  readonly model: string
  readonly messages: readonly Message[]
  readonly jsonSchema?: JSONSchema
  readonly maxTokens?: number
  readonly cachePrefix?: CachePrefix
}

export interface ProviderResult {
  readonly data: unknown
  readonly usage: TokenUsage
  readonly modelVersion: string
}

export type CompatibleProvider = 'openai' | 'deepseek'

export interface OpenAICompatibleConfig {
  readonly provider: CompatibleProvider
  readonly apiKey: string
  readonly baseUrl: string
  readonly fetchImpl?: typeof fetch
  /** DeepSeek 只支持 `json_object`；OpenAI 用 `json_schema` 强制结构 */
  readonly jsonMode?: 'json_schema' | 'json_object'
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig) {
  const jsonMode = config.jsonMode ?? 'json_schema'
  const doFetch = config.fetchImpl ?? fetch

  return async function call(input: ProviderCall): Promise<ProviderResult> {
    const prefixText = input.cachePrefix?.text?.trim()

    const messages: Array<{ role: string; content: string }> = [
      ...(prefixText ? [{ role: 'system', content: prefixText }] : []),
      ...input.messages.map((message) => ({ role: message.role as string, content: message.content })),
    ]

    // DeepSeek 的 json_object 模式要求 prompt 里显式出现 "json" 字样
    if (input.jsonSchema && jsonMode === 'json_object') {
      messages.push({
        role: 'system',
        content: '只输出一个 JSON 对象（json），不要输出任何解释、不要用 Markdown 代码块。',
      })
    }

    const body: Record<string, unknown> = {
      model: input.model,
      messages,
      max_tokens: input.maxTokens ?? 2048,
    }

    if (input.jsonSchema) {
      body.response_format =
        jsonMode === 'json_object'
          ? { type: 'json_object' }
          : {
              type: 'json_schema',
              json_schema: { name: 'studygraph_result', strict: true, schema: input.jsonSchema },
            }
    }

    if (input.cachePrefix?.key && config.provider === 'openai') {
      // 只有 OpenAI 有显式路由键；DeepSeek 是自动上下文缓存（SG-SUP-009 §3.1）
      body.prompt_cache_key = input.cachePrefix.key
    }

    const response = await doFetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`${config.provider} ${response.status}: ${text.slice(0, 400)}`)
    }

    const payload = (await response.json()) as {
      model?: unknown
      choices?: Array<{ message?: { content?: string } }>
      usage?: unknown
    }

    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error(`${config.provider} 返回缺少 message.content`)

    let data: unknown
    try {
      data = JSON.parse(content)
    } catch {
      throw new Error(`${config.provider} 返回的内容不是合法 JSON：${content.slice(0, 200)}`)
    }

    const { modelVersion, usage } = assertUsageAndModel(config.provider, payload, (raw) => {
      if (config.provider === 'deepseek') {
        // DeepSeek 把缓存命中直接写在 usage 里（009 §3.1），最省事的一家
        return {
          tokensIn: raw.prompt_tokens,
          tokensOut: raw.completion_tokens,
          cachedTokens: raw.prompt_cache_hit_tokens,
        }
      }
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
