/**
 * LLM Gateway 的类型契约（SG-SUP-004 §3.2）。
 *
 * 字段名按规格原文，不许改：
 *   taskType / messages / jsonSchema / cachePrefixKey / user
 * 返回值：{ data, usage }，usage 必须是**厂商返回的真实值**。
 */
import type { UserCtx } from './user.ts'

export interface Message {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export interface TokenUsage {
  readonly tokensIn: number
  readonly tokensOut: number
  /** 命中前缀缓存的输入 token（厂商返回的 cached_tokens） */
  readonly cachedTokens: number
}

/** 只要求是 JSON Schema 对象；具体校验交给厂商与调用方。 */
export type JSONSchema = Record<string, unknown>

export const TASK_TYPES = [
  'chunk',
  'extract',
  'quiz',
  'probe',
  'method',
  'solve',
  'variant',
  'check',
  'judge',
] as const

export type TaskType = (typeof TASK_TYPES)[number]

/**
 * 前缀材料（SG-SUP-006 §3.3）。
 *
 * `key` 与 `text` 都由调用方从 `(sourceId, 章节范围, promptVersion)` 派生：
 * - `key`：缓存标识，用于 OpenAI 的 `prompt_cache_key`、日志与指标
 * - `text`：真正进 system 前缀的原文片段，Anthropic 是内容寻址，靠它命中缓存
 *
 * 两者必须同时给：只给 key 对 Anthropic 等于没接缓存，只给 text 对 OpenAI 少了路由键。
 */
export interface CachePrefix {
  readonly key: string
  readonly text: string
}

export interface LLMCompleteRequest {
  readonly taskType: TaskType
  readonly messages: readonly Message[]
  readonly jsonSchema?: JSONSchema
  /** 前缀材料（新接口） */
  readonly cachePrefix?: CachePrefix
  /** @deprecated 旧调用方只传键；内部等价于 `{ key, text: '' }`。新代码请用 cachePrefix */
  readonly cachePrefixKey?: string
  readonly user: UserCtx
}

export interface LLMCompleteResult {
  readonly data: unknown
  readonly usage: TokenUsage
  /** 厂商返回的真实模型标识，参与指纹计算 */
  readonly modelVersion: string
}

export interface LLMGateway {
  complete(req: LLMCompleteRequest): Promise<{ data: unknown; usage: TokenUsage; modelVersion: string }>
}
