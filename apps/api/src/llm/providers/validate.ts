import { providerResponseInvalid } from '../../lib/errors.ts'
import type { TokenUsage } from '../types.ts'

/**
 * 适配器响应校验（SG-SUP-005 缺陷 D）。
 *
 * 缺 `usage` 或 `model` 时**必须抛错**：
 * - `usage` 全 0 → 额度计量失效，学生不知道花了多少
 * - `modelVersion` 回退到请求别名 → 指纹里的 modelVersion 失去意义（同一别名背后可能换模型）
 *
 * `cachedTokens` 是唯一允许缺省的字段（两家厂商都是可选），缺省记 0；
 * 但 `tokensIn` / `tokensOut` 必须存在且为非负数——"字段不存在"与"值为 0"要分开。
 */
export interface UsageFields {
  readonly tokensIn: unknown
  readonly tokensOut: unknown
  readonly cachedTokens?: unknown
}

export function assertUsageAndModel(
  provider: 'openai' | 'anthropic' | 'deepseek',
  payload: { model?: unknown; usage?: unknown },
  readUsage: (usage: Record<string, unknown>) => UsageFields,
): { modelVersion: string; usage: TokenUsage } {
  const missing: string[] = []

  if (typeof payload.model !== 'string' || payload.model.trim().length === 0) missing.push('model')
  if (payload.usage === null || typeof payload.usage !== 'object') missing.push('usage')
  if (missing.length > 0) throw providerResponseInvalid(provider, missing)

  const usage = readUsage(payload.usage as Record<string, unknown>)

  const invalid: string[] = []
  for (const [name, value] of [
    ['usage.tokensIn', usage.tokensIn],
    ['usage.tokensOut', usage.tokensOut],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid.push(name)
  }
  if (
    usage.cachedTokens !== undefined &&
    (typeof usage.cachedTokens !== 'number' || !Number.isFinite(usage.cachedTokens) || usage.cachedTokens < 0)
  ) {
    invalid.push('usage.cachedTokens')
  }
  if (invalid.length > 0) throw providerResponseInvalid(provider, invalid)

  return {
    modelVersion: payload.model as string,
    usage: {
      tokensIn: usage.tokensIn as number,
      tokensOut: usage.tokensOut as number,
      cachedTokens: (usage.cachedTokens as number | undefined) ?? 0,
    },
  }
}
