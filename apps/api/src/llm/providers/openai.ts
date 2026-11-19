import type { JSONSchema, Message, TokenUsage } from '../types.ts'
import type { ProviderCall, ProviderResult } from './openai-compatible.ts'
import { createOpenAICompatibleProvider } from './openai-compatible.ts'

export type { ProviderCall, ProviderResult }
export type { JSONSchema, Message, TokenUsage }

export interface OpenAIProviderConfig {
  readonly apiKey: string
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
}

/**
 * OpenAI 适配层（实现已抽到 `openai-compatible.ts`，DeepSeek 共用同一份）。
 *
 * - 结构化输出用 `response_format: json_schema` 强制，不解析模型自由文本
 * - `usage` / `model` 缺失即抛 PROVIDER_RESPONSE_INVALID
 * - `cachePrefix.text` 进 system 前缀；`cachePrefix.key` 进 `prompt_cache_key`
 */
export function createOpenAIProvider(config: OpenAIProviderConfig) {
  return createOpenAICompatibleProvider({
    provider: 'openai',
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
    fetchImpl: config.fetchImpl,
    jsonMode: 'json_schema',
  })
}
