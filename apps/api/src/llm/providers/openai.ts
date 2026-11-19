import type { JSONSchema, Message, TokenUsage } from '../types.ts'

export interface ProviderCall {
  readonly model: string
  readonly messages: readonly Message[]
  readonly jsonSchema?: JSONSchema
  readonly maxTokens?: number
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
 * 结构化输出用 `response_format: json_schema` 强制，不解析模型自由文本
 * （规格 §3.6：不许靠正则解析）。
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
      model?: string
      choices?: Array<{ message?: { content?: string } }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      }
    }

    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('OpenAI 返回缺少 message.content')

    let data: unknown
    try {
      data = JSON.parse(content)
    } catch {
      throw new Error(`OpenAI 返回的内容不是合法 JSON：${content.slice(0, 200)}`)
    }

    return {
      data,
      usage: {
        tokensIn: payload.usage?.prompt_tokens ?? 0,
        tokensOut: payload.usage?.completion_tokens ?? 0,
        cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      modelVersion: payload.model ?? input.model,
    }
  }
}
