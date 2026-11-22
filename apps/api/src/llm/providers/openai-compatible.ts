import type {
  AgentMessage,
  AgentRequest,
  AgentResult,
  CachePrefix,
  JSONSchema,
  Message,
  TokenUsage,
  ToolCall,
  ToolSpec,
} from '../types.ts'
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

/**
 * 输出额度。
 *
 * 2048 是历史默认值，现在不够用了：DeepSeek 当前模型把**思考 token 也算进
 * `completion_tokens`**，同一份 2048 的预算，思考先吃掉大半，剩下的 JSON
 * 写到一半被切断（`finish_reason: length`），有的干脆一个字都没有。
 * 实测 `deepseek-flash` / `deepseek-v4-pro` 都接受 8192 与 16384。
 */
const DEFAULT_MAX_TOKENS = 4096
const HARD_MAX_TOKENS = 16384

/**
 * 从一段可能夹着围栏、寒暄、解释的文字里取出 JSON 值。
 *
 * 模型经常这样返回：`好的，以下是结果：\n```json\n{...}\n````。
 * 这种情况下 `JSON.parse` 必然失败，但内容其实是好的 —— 因为包装层判死
 * 等于白白扔掉一次已经付过钱的调用。
 *
 * **但只取完整的**：括号没闭合就返回 null，让上层按"截断"处理，
 * 绝不试图补括号 —— 半份定义比没有定义更危险。
 */
function extractJsonValue(text: string): string | null {
  const start = text.search(/[{\[]/)
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return null
}

function parseLooseJson(content: string): unknown {
  const trimmed = content.replace(/^﻿/, '').trim()
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(trimmed)?.[1]?.trim()

  for (const candidate of fenced ? [trimmed, fenced] : [trimmed]) {
    try {
      return JSON.parse(candidate)
    } catch {
      // 继续尝试更宽松的取法
    }
  }

  const sliced = extractJsonValue(fenced ?? trimmed)
  if (sliced) return JSON.parse(sliced)
  throw new Error('no-json')
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

    /**
     * 结构化输出靠两条腿：`response_format` + 明确的语言指令。
     *
     * 语言指令无论如何都加：有的厂商/模型会拒掉 `response_format`
     * （DeepSeek 现在的 flash / v4-pro 就返回
     * "This response_format type is unavailable now"），
     * 那时只能靠指令让模型自己输出 JSON。见下面的降级重试。
     *
     * 指令里带上 schema 原文：降级后模型看不到 `response_format`，
     * 只靠一句"输出 JSON"它就会自由发挥字段名（实测它会把 `title` 写成
     * `label`、`from/to` 写成 `source/target`）。
     */
    if (input.jsonSchema) {
      messages.push({
        role: 'system',
        content:
          '只输出一个 JSON 对象（json），不要输出任何解释、不要用 Markdown 代码块。' +
          '对象必须严格满足这个 JSON Schema：' +
          JSON.stringify(input.jsonSchema),
      })
    }

    const post = (payload: Record<string, unknown>) =>
      doFetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(payload),
      })

    /**
     * `response_format` 被拒时的降级阶梯：`json_schema` → `json_object` → 不带格式。
     *
     * DeepSeek 拒 `json_schema` 但**接受 `json_object`**（实测），
     * 所以第一步不要直接扔掉格式 —— 那等于把结构约束一起扔了。
     * 有的厂商只支持 `json_schema`，第二步保留 `json_schema` 不动。
     * 每一步都必须确认错误确实是 `response_format` 引起的，
     * 401 / 429 重试没有意义，只会多花一次请求。
     */
    const postWithFormatFallback = async (payload: Record<string, unknown>) => {
      const first = await post(payload)
      if (first.ok || !payload.response_format) return first

      const firstText = await first.clone().text().catch(() => '')
      if (!/response_format|json_schema|json_object|unavailable/i.test(firstText)) return first

      const currentType = (payload.response_format as { type?: string }).type

      if (currentType !== 'json_object') {
        const second = await post({ ...payload, response_format: { type: 'json_object' } })
        if (second.ok) return second

        const secondText = await second.clone().text().catch(() => '')
        if (!/response_format|json_schema|json_object|unavailable/i.test(secondText)) return second
      }

      const { response_format: _dropped, ...rest } = payload
      void _dropped
      return post(rest)
    }

    let budget = Math.min(Math.max(input.maxTokens ?? DEFAULT_MAX_TOKENS, 512), HARD_MAX_TOKENS)
    let retriedForLength = false

    for (;;) {
      const body: Record<string, unknown> = {
        model: input.model,
        messages,
        max_tokens: budget,
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

      const response = await postWithFormatFallback(body)

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`${config.provider} ${response.status}: ${text.slice(0, 400)}`)
      }

      const payload = (await response.json()) as {
        model?: unknown
        choices?: Array<{
          message?: { content?: string; reasoning_content?: string }
          finish_reason?: string
        }>
        usage?: unknown
      }

      const choice = payload.choices?.[0]
      const content = choice?.message?.content
      const finishReason = choice?.finish_reason
      const reasoningChars =
        typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content.length : 0

      /**
       * 额度用完 → 翻倍重试**一次**。
       *
       * 两种表现其实是同一件事：
       * - `finish_reason: length` 且 JSON 断在半截
       * - `content` 为空（思考把额度全吃了，一个字都没轮到输出）
       * 用户看到的都是"不是合法 JSON"，但重发一遍（同一额度）不会好，
       * 只有把预算加大才有意义。所以只翻一次，避免无底洞烧钱。
       */
      const empty = typeof content !== 'string' || content.trim().length === 0
      if ((empty || finishReason === 'length') && !retriedForLength && budget < HARD_MAX_TOKENS) {
        retriedForLength = true
        budget = Math.min(budget * 2, HARD_MAX_TOKENS)
        continue
      }

      if (empty) {
        throw new Error(
          `${config.provider} 没有返回内容` +
            (reasoningChars > 0
              ? `：模型把 ${budget} 个输出额度花在思考上了（reasoning ${reasoningChars} 字符），没有产出答案`
              : `（finish_reason=${finishReason ?? 'unknown'}）`),
        )
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

      /**
       * 没要求 JSON 的调用**不解析内容**，原样当文本返回。
       *
       * 这是"什么时候强制 JSON、什么时候开放"的分界线：
       *   · 要写进产物、要被程序读字段的（抽取、出题、讲义…）→ 调用方传 jsonSchema，强制 JSON
       *   · 对话就是对话（节点里的问答、解释、追问）→ 不传 jsonSchema，模型怎么写就怎么回
       * 以前这里无条件 JSON.parse，于是一段正常的解释文字被判成
       * "返回的内容不是合法 JSON" —— 错的是解析方，不是模型。
       */
      if (!input.jsonSchema) {
        return { data: { text: content.trim() }, usage, modelVersion }
      }

      let data: unknown
      try {
        data = parseLooseJson(content)
      } catch {
        // 截断和"模型没按要求输出"是两件事，告诉用户/日志时不能混为一谈
        throw new Error(
          finishReason === 'length'
            ? `${config.provider} 输出被截断（max_tokens=${budget} 已用完），JSON 不完整：${content.slice(0, 200)}`
            : `${config.provider} 返回的内容不是合法 JSON：${content.slice(0, 200)}`,
        )
      }

      return { data, usage, modelVersion }
    }
  }
}

/**
 * 原生工具调用（function calling）。
 *
 * 与 `call` 分开写而不是塞进同一个函数：普通调用要 `response_format` 强制 JSON，
 * agent 调用要 `tools` —— 两者的重试策略、成功判据都不一样
 * （agent 的一次成功可能是"一个字没说，只调了个工具"）。
 *
 * DeepSeek 实测：`tool_choice: 'auto'` 可用；强制指定某个工具会被
 * "Thinking mode does not support this tool_choice" 拒绝。
 * 所以这里固定 `auto`，靠提示词让模型自己动手。
 */
export interface AgentProviderCall {
  readonly model: string
  readonly messages: readonly AgentMessage[]
  readonly tools: readonly ToolSpec[]
  readonly maxTokens?: number
}

export function createOpenAICompatibleAgent(config: OpenAICompatibleConfig) {
  const doFetch = config.fetchImpl ?? fetch

  const toWire = (message: AgentMessage): Record<string, unknown> => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
    }
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content.length > 0 ? message.content : null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      }
    }
    return { role: message.role, content: message.content }
  }

  return async function chat(input: AgentProviderCall): Promise<AgentResult> {
    let budget = Math.min(Math.max(input.maxTokens ?? DEFAULT_MAX_TOKENS, 512), HARD_MAX_TOKENS)
    let retriedForLength = false

    for (;;) {
      const body = {
        model: input.model,
        messages: input.messages.map(toWire),
        max_tokens: budget,
        tools: input.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        // DeepSeek 的 thinking 模式只接受 auto：强制指定工具会被 400 拒绝
        tool_choice: 'auto',
      }

      const response = await doFetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`${config.provider} ${response.status}: ${text.slice(0, 400)}`)
      }

      const payload = (await response.json()) as {
        model?: unknown
        choices?: Array<{
          message?: {
            content?: string | null
            reasoning_content?: string
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
          }
          finish_reason?: string
        }>
        usage?: unknown
      }

      const choice = payload.choices?.[0]
      const content = choice?.message?.content ?? ''
      const finishReason = choice?.finish_reason
      const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? [])
        .filter((call) => typeof call.function?.name === 'string')
        .map((call, index) => ({
          id: call.id ?? `call_${index}`,
          name: call.function!.name!,
          arguments: call.function?.arguments ?? '{}',
        }))

      /**
       * 额度耗尽的重试：与普通调用同一个坑 —— 思考 token 也算输出。
       * 但判据不同：这里"没有 tool_calls 也没有文字"才算空转。
       */
      const emptyTurn = content.trim().length === 0 && toolCalls.length === 0
      if ((emptyTurn || finishReason === 'length') && !retriedForLength && budget < HARD_MAX_TOKENS) {
        retriedForLength = true
        budget = Math.min(budget * 2, HARD_MAX_TOKENS)
        continue
      }

      if (emptyTurn) {
        throw new Error(
          `${config.provider} 没有返回内容，也没有调用任何工具` +
            (finishReason === 'length' ? `（max_tokens=${budget} 已用完）` : `（finish_reason=${finishReason ?? 'unknown'}）`),
        )
      }

      const { modelVersion, usage } = assertUsageAndModel(config.provider, payload, (raw) => {
        if (config.provider === 'deepseek') {
          return {
            tokensIn: raw.prompt_tokens,
            tokensOut: raw.completion_tokens,
            cachedTokens: raw.prompt_cache_hit_tokens,
          }
        }
        const details = raw.prompt_tokens_details as { cached_tokens?: unknown } | undefined
        return { tokensIn: raw.prompt_tokens, tokensOut: raw.completion_tokens, cachedTokens: details?.cached_tokens }
      })

      return { content, toolCalls, usage, modelVersion, provider: config.provider }
    }
  }
}
