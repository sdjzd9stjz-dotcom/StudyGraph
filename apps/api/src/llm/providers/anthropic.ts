import type { AgentProviderCall } from './openai-compatible.ts'
import type { AgentResult, JSONSchema, Message, TokenUsage } from '../types.ts'
import type { ProviderCall, ProviderResult } from './openai.ts'
import { readUsageFields } from './cache-usage.ts'
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
export function anthropicMessagesUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/messages'
}

async function send(config: AnthropicProviderConfig, body: Record<string, unknown>) {
  const doFetch = config.fetchImpl ?? fetch
  const response = await doFetch(anthropicMessagesUrl(config.baseUrl ?? 'https://api.anthropic.com'), {
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

  return (await response.json()) as {
    model?: unknown
    content?: Array<{ type: string; id?: string; name?: string; input?: unknown; text?: string; [key: string]: unknown }>
    usage?: unknown
  }

}

function effortOptions(model: string, effort?: string) {
  if (!effort) return {}
  return { output_config: { effort }, ...(!/^claude-opus-4-5(?:-|$)/.test(model) ? { thinking: { type: 'adaptive' } } : {}) }
}

export function createAnthropicProvider(config: AnthropicProviderConfig) {

  return async function call(input: ProviderCall): Promise<ProviderResult> {
    const systemMessages = input.messages.filter((message) => message.role === 'system')
    const dialogue = input.messages.filter((message) => message.role !== 'system')

    const body: Record<string, unknown> = {
      model: input.model,
      ...effortOptions(input.model, input.effort),
      max_tokens: input.maxTokens ?? 4096,
      messages: dialogue.map((message, index) => ({
        role: message.role,
        // 本轮问题会原样出现在下一轮历史中；仅为有后续轮次的节点对话写缓存。
        content: input.cacheConversation && index === dialogue.length - 1 && message.role === 'user' && message.content
          ? [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }]
          : message.content,
      })),
    }

    // 前缀材料进 system（Anthropic 是内容寻址：缓存的就是这段内容本身）。
    // 顺序：缓存前缀在前，调用方 system 在后；**最后一个块**打 cache_control 断点。
    const systemBlocks: Array<Record<string, unknown>> = []
    const prefixText = input.cachePrefix?.text?.trim()
    if (prefixText) systemBlocks.push({ type: 'text', text: prefixText })
    if (systemMessages.length > 0) {
      systemBlocks.push({ type: 'text', text: systemMessages.map((message) => message.content).join('\n\n') })
    }
    if (input.jsonSchema && body.thinking) systemBlocks.push({ type: 'text', text: '请调用 emit_result 返回结构化结果。' })
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
      body.tool_choice = body.thinking ? { type: 'auto' } : { type: 'tool', name: 'emit_result' }
    }

    const payload = await send(config, body)

    const toolUse = payload.content?.find((block) => block.type === 'tool_use')
    const textBlock = payload.content?.find((block) => block.type === 'text')

    let data: unknown
    if (toolUse) {
      data = toolUse.input
    } else if (textBlock?.text && !input.jsonSchema) {
      data = { text: textBlock.text }
    } else if (textBlock?.text) {
      try {
        data = JSON.parse(textBlock.text)
      } catch {
        throw new Error(`Anthropic 返回的内容不是合法 JSON：${textBlock.text.slice(0, 200)}`)
      }
    } else {
      throw new Error('Anthropic 返回既没有 tool_use 也没有 text')
    }

    const { modelVersion, usage } = assertUsageAndModel('anthropic', payload, readUsageFields)

    return { data, usage, modelVersion }
  }
}

export function createAnthropicAgent(config: AnthropicProviderConfig) {
  return async (input: AgentProviderCall): Promise<AgentResult> => {
    const messages: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] = []
    for (const message of input.messages) {
      if (message.role === 'system') continue
      const role = message.role === 'tool' ? 'user' : message.role
      const blocks = message.role === 'assistant' && message.nativeContent ? message.nativeContent
        : message.role === 'tool' ? [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]
        : [{ type: 'text', text: message.content }]
      const previous = messages.at(-1)
      if (previous?.role === role) previous.content.push(...blocks)
      else messages.push({ role, content: [...blocks] })
    }
    const payload = await send(config, { model: input.model, max_tokens: input.maxTokens ?? 4096,
      ...effortOptions(input.model, input.effort), messages,
      system: input.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
      tools: input.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
    })
    const blocks = payload.content ?? []
    const toolCalls = blocks.filter(b => b.type === 'tool_use' && b.id && b.name).map(b => ({ id: b.id!, name: b.name!, arguments: JSON.stringify(b.input ?? {}) }))
    const content = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
    if (!content && !toolCalls.length) throw Error('模型未能在当前输出额度内回答或调用工具')
    return { ...assertUsageAndModel('anthropic', payload, readUsageFields), provider: 'anthropic', content,
      toolCalls, nativeContent: blocks }
  }
}

export type AnthropicCall = (input: ProviderCall) => Promise<ProviderResult>
export type { JSONSchema, Message, TokenUsage }
