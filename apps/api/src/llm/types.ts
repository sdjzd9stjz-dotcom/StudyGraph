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

/**
 * 工具调用（agent）。
 *
 * 底部对话栏不是"让模型写一段话再解析"，而是把画布操作当成工具交给模型，
 * 模型自己决定调哪一个、按什么顺序调。**工具本身由服务端实现**，
 * 模型只能通过这些工具碰画布 —— 没有文件、没有网络、不能执行节点。
 *
 * DeepSeek 的 thinking 模式只支持 `tool_choice: auto`（强制指定工具会被 400 拒绝），
 * 所以这里不提供强制选项：靠 system prompt 说清楚"该动手就动手"。
 */
export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: JSONSchema
}

export interface ToolCall {
  readonly id: string
  readonly name: string
  /** 模型给的 JSON 字符串，可能不合法；由执行方解析并拒绝 */
  readonly arguments: string
}

export type AgentMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string }

export interface AgentRequest {
  readonly taskType: TaskType
  readonly messages: readonly AgentMessage[]
  readonly tools: readonly ToolSpec[]
  readonly user: UserCtx
  readonly maxTokens?: number
}

export interface AgentResult {
  readonly content: string
  readonly toolCalls: readonly ToolCall[]
  readonly usage: TokenUsage
  readonly modelVersion: string
  readonly provider: import('./routing.ts').ProviderId
}

export interface LLMCompleteRequest {
  readonly taskType: TaskType
  readonly messages: readonly Message[]
  readonly jsonSchema?: JSONSchema
  /**
   * 输出额度上限。不传时用适配器默认值。
   *
   * 必须能传下去：DeepSeek 现在的模型把**思考 token 也算进输出额度**，
   * 同一个 2048 的预算，有的模型能写完 JSON，有的思考完就没了。
   * 需要列清单的任务（如概念抽取）只能按任务抬高它。
   */
  readonly maxTokens?: number
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
  routeFor(task: TaskType): import('./routing.ts').ModelRoute
  complete(req: LLMCompleteRequest): Promise<LLMCompleteResult & { provider: import('./routing.ts').ProviderId }>
  /** 带工具的一轮对话（agent 循环的每一步） */
  chatWithTools(req: AgentRequest): Promise<AgentResult>
}
