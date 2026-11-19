import { createOpenAICompatibleProvider } from './openai-compatible.ts'

/**
 * DeepSeek 适配层（SG-SUP-009 §2.1 方案 A：参数化复用 OpenAI 兼容实现）。
 *
 * 与 OpenAI 的差异只有三处，全部落在配置里：
 * - base URL：`https://api.deepseek.com`
 * - 结构化输出：只支持 `response_format: { type: 'json_object' }`（要求 prompt 里出现 "json"）
 * - usage 口径：`prompt_cache_hit_tokens` → `cachedTokens`
 *
 * 不变的三条既有约束（005/006 已定，这里同样适用）：
 * usage/model 缺失即报错；modelVersion 只取响应体；失败必须抛。
 */

export interface DeepSeekProviderConfig {
  readonly apiKey: string
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
}

export function createDeepSeekProvider(config: DeepSeekProviderConfig) {
  return createOpenAICompatibleProvider({
    provider: 'deepseek',
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? 'https://api.deepseek.com',
    fetchImpl: config.fetchImpl,
    jsonMode: 'json_object',
  })
}
