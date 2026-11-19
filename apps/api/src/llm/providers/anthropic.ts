import type { JSONSchema, Message, TokenUsage } from '../types.ts'
import type { ProviderCall, ProviderResult } from './openai.ts'
import { assertUsageAndModel } from './validate.ts'

export interface AnthropicProviderConfig {
  readonly apiKey: string
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
}

/**
 * Anthropic Messages 适配层。
 *
 * - 结构化输出用 tool_use 强制（`tool_choice: tool`），拿到的是 `input` 对象
 * - `usage` / `model` 缺失即抛 PROVIDER_RESPONSE_INVALID
 * - **前缀缓存**：Anthropic 的缓存维度就是 system 前缀内容本身，没有独立缓存键参数。
 *   `cachePrefixKey` 在这里的用途是决定**是否打缓存断点**（`cache_control: ephemeral`），
 *   不改变文案、也不伪造一个厂商不认识的字段。这一点写进了 docs/architecture.md §5.2。
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

    // 前缀材料进 system（Anthropic 是内容寻址：缓存的就是这段内容本身）。
    // 顺序：缓存前缀在前，调用方 system 在后；**最后一个块**打 cache_control 断点。
    const systemBlocks: Array<Record<string, unknown>> = []
    const prefixText = input.cachePrefix?.text?.trim()
    if (prefixText) systemBlocks.push({ type: 'text', text: prefixText })
    if (systemMessages.length > 0) {
      systemBlocks.push({ type: 'text', text: systemMessages.map((message) => message.content).join('\n\n') })
    }
    if (systemBlocks.length > 0) {
      const last = systemBlocks[systemBlocks.length - 1] as Record<string, unknown>
      last.cache_control = { type: 'ephemeral' }
      body.system = systemBlocks
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
      model?: unknown
      content?: Array<{ type: string; input?: unknown; text?: string }>
      usage?: unknown
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

    const { modelVersion, usage } = assertUsageAndModel('anthropic', payload, (raw) => ({
      tokensIn: raw.input_tokens,
      tokensOut: raw.output_tokens,
      cachedTokens: raw.cache_read_input_tokens,
    }))

    return { data, usage, modelVersion }
  }
}

export type AnthropicCall = (input: ProviderCall) => Promise<ProviderResult>
export type { JSONSchema, Message, TokenUsage }
