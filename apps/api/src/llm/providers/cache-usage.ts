import type { UsageFields } from './validate.ts'

/** 中转站可能在同一个端点上混用不同厂商的用量格式，因此按响应字段识别。 */
export function readUsageFields(raw: Record<string, unknown>): UsageFields {
  const details = (raw.prompt_tokens_details ?? raw.input_tokens_details) as { cached_tokens?: unknown } | undefined
  const cachedTokens = details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cache_read_input_tokens
  let tokensIn = raw.prompt_tokens ?? raw.input_tokens
  if (typeof raw.input_tokens === 'number' && raw.prompt_tokens === undefined &&
      ('cache_read_input_tokens' in raw || 'cache_creation_input_tokens' in raw)) {
    const read = raw.cache_read_input_tokens ?? 0, created = raw.cache_creation_input_tokens ?? 0
    tokensIn = typeof read === 'number' && typeof created === 'number' && read >= 0 && created >= 0
      ? raw.input_tokens + read + created : undefined
  }
  return { tokensIn, tokensOut: raw.completion_tokens ?? raw.output_tokens, cachedTokens }
}

export function meteredUsage(raw: Record<string, unknown>) {
  const fields = readUsageFields(raw)
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  return { tokensIn: valid(fields.tokensIn) ? fields.tokensIn : 0, tokensOut: valid(fields.tokensOut) ? fields.tokensOut : 0,
    cachedTokens: valid(fields.cachedTokens) ? fields.cachedTokens : 0, cacheUsageComplete: valid(fields.cachedTokens) }
}

/** 逐行解析 SSE 的数据帧，字节和 JSON 跨网络分块时仍保留最后的累计用量。 */
export async function forwardMeteredStream(response: Response, write: (bytes: Uint8Array) => void) {
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  const usage: Record<string, unknown> = {}
  let pending = '', data: string[] = []
  function event() {
    if (!data.length) return
    const value = data.join('\n')
    data = []
    try {
      const frame = JSON.parse(value)
      Object.assign(usage, frame?.message?.usage, frame?.usage)
    } catch { /* 心跳与 [DONE] 没有用量。 */ }
  }
  function line(s: string) {
    if (!s.trim()) event()
    else if (s.startsWith('data:')) data.push(s.slice(5).trimStart())
  }
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        write(value)
        const lines = (pending + decoder.decode(value, { stream: true })).split('\n')
        pending = lines.pop()!
        for (const text of lines) line(text.replace(/\r$/, ''))
      }
      line(pending + decoder.decode())
      event()
    } finally { reader.releaseLock() }
  }
  return meteredUsage(usage)
}
