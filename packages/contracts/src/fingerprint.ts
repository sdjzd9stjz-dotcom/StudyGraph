import { createHash } from 'node:crypto'

/**
 * 指纹与版本号（SG-SUP-004 §3.8）。
 *
 * 规格原文：
 *   fingerprint = sha256(
 *     canonicalJson(上游 artifacts 的 hash 列表) + canonicalJson(node.params)
 *     + modelVersion + promptVersion
 *   )
 *
 * 两个"必须是算出来的、不能手写"的值：
 *
 * - `promptVersion` = sha256(prompt 文本).slice(0, 12)。
 *   手写常量 `PROMPT_VERSION='v1'` 的失败模式是：改了 prompt 忘了改常量 → 命中旧缓存，
 *   而没人会发现。用文本哈希则改一个字就自动失效。
 * - `modelVersion` 由调用方传入**厂商返回的真实模型标识**（如 gpt-4o-mini-2024-07-18），
 *   不是配置里的别名。
 */

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** 对象键排序、丢弃 undefined 的稳定序列化。键序不同但内容相同 → 同一字符串。 */
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (input !== null && typeof input === 'object') {
      const record = input as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort()) {
        const item = record[key]
        if (item === undefined) continue
        out[key] = normalize(item)
      }
      return out
    }
    return input
  }

  return JSON.stringify(normalize(value))
}

/** prompt 模板文本 → 12 位版本号。改一个字就变。 */
export function promptVersionOf(promptText: string): string {
  return sha256Hex(promptText).slice(0, 12)
}

export interface FingerprintInput {
  /** 上游 artifacts 的 hash（顺序无关：内部排序后再哈希） */
  readonly upstreamArtifactHashes: readonly string[]
  readonly params: unknown
  /** 厂商返回的真实模型标识 */
  readonly modelVersion: string
  /** promptVersionOf(prompt 文本) */
  readonly promptVersion: string
}

export function computeFingerprint(input: FingerprintInput): string {
  const payload = [
    canonicalJson([...input.upstreamArtifactHashes].sort()),
    canonicalJson(input.params ?? {}),
    input.modelVersion,
    input.promptVersion,
  ].join('\u0000')

  return sha256Hex(payload)
}
