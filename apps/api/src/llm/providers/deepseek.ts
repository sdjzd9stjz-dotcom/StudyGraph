import { providerResponseInvalid } from '../../lib/errors.ts'
import { assertUsageAndModel } from './validate.ts'
import type { ProviderCall, ProviderResult } from './openai-compatible.ts'
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
  const inner = createOpenAICompatibleProvider({
    provider: 'deepseek',
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? 'https://api.deepseek.com',
    fetchImpl: config.fetchImpl,
    jsonMode: 'json_object',
  })

  return async function call(input: ProviderCall): Promise<ProviderResult> {
    return inner(input)
  }
}

/**
 * DeepSeek 的 usage 字段缺失检查（009 §2.2：字段不存在 ≠ 值为 0）。
 * 单独导出便于单测直接打这个点。
 */
export function assertDeepSeekUsage(payload: { model?: unknown; usage?: unknown }): {
  cachedTokens: number
} {
  const usage = payload.usage as Record<string, unknown> | undefined
  if (!usage || typeof usage.prompt_cache_hit_tokens !== 'number') {
    throw providerResponseInvalid('deepseek', ['usage.prompt_cache_hit_tokens'])
  }
  const { usage: normalized } = assertUsageAndModel('deepseek', payload, (raw) => ({
    tokensIn: raw.prompt_tokens,
    tokensOut: raw.completion_tokens,
    cachedTokens: raw.prompt_cache_hit_tokens,
  }))
  return { cachedTokens: normalized.cachedTokens }
}
