import type { JSONSchema, Message, TokenUsage } from '../types.ts'
import type { ProviderCall, ProviderResult } from './openai.ts'

export interface AnthropicProviderConfig {
  readonly apiKey: string
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
}

/**
 * Anthropic Messages 适配层。
 *
 * 结构化输出用 tool_use 强制（`tool_choice: tool`），拿到的是 `input` 对象，
 * 不需要解析自由文本。
 *
 * 前缀缓存：把 system 段标成 `cache_control: ephemeral`，命中时厂商返回
 * `cache_read_input_tokens`，我们逐字记进 `cachedTokens`。
 */
export function createAnthropicProvider(config: AnthropicProviderConfig) {
  const baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1'
  const doFetch = config.fetchImpl ?? fetch

  return async function call(input: ProviderCall): Promise<ProviderResult> {
    const systemMessages = input.messages.filter((message) => message.role === 'system')
    const dialogue = input.messages.filter((message) => message.role !== 'system')

    const body: Record<string, unknown> = {
      model: input.model,
      max_tokens: input.maxTokens ?? 4096,
      messages: dialogue.map((message) => ({ role: message.role, content: message.content })),
    }

    if (systemMessages.length > 0) {
      body.system = [
        {
          type: 'text',
          text: systemMessages.map((message) => message.content).join('\n\n'),
          // 教材原文作前缀，命中缓存可省输入成本（规格 §5.2）
          cache_control: { type: 'ephemeral' },
        },
      ]
    }

    if (input.jsonSchema) {
      body.tools = [
        {
          name: 'emit_result',
          description: '按给定 JSON Schema 输出结果',
          input_schema: input.jsonSchema,
        },
      ]
      body.tool_choice = { type: 'tool', name: 'emit_result' }
    }

    const response = await doFetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Anthropic ${response.status}: ${text.slice(0, 400)}`)
    }

    const payload = (await response.json()) as {
      model?: string
      content?: Array<{ type: string; input?: unknown; text?: string }>
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
      }
    }

    const toolUse = payload.content?.find((block) => block.type === 'tool_use')
    const textBlock = payload.content?.find((block) => block.type === 'text')

    let data: unknown
    if (toolUse) {
      data = toolUse.input
    } else if (textBlock?.text) {
      try {
        data = JSON.parse(textBlock.text)
      } catch {
        throw new Error(`Anthropic 返回的内容不是合法 JSON：${textBlock.text.slice(0, 200)}`)
      }
    } else {
      throw new Error('Anthropic 返回既没有 tool_use 也没有 text')
    }

    return {
      data,
      usage: {
        tokensIn: payload.usage?.input_tokens ?? 0,
        tokensOut: payload.usage?.output_tokens ?? 0,
        cachedTokens: payload.usage?.cache_read_input_tokens ?? 0,
      },
      modelVersion: payload.model ?? input.model,
    }
  }
}

export type AnthropicCall = (input: ProviderCall) => Promise<ProviderResult>
export type { JSONSchema, Message, TokenUsage }
