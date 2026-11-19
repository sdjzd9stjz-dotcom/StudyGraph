import type { JSONSchema, LLMGateway, TokenUsage } from '../llm/types.ts'
import type { UserCtx } from '../llm/user.ts'
import type { SpanResolver } from '../spans/resolver.ts'

/**
 * 节点执行器契约（规格原文，字段名不许改）。
 *
 * 注意 `type` 是 string 而不是 NodeType：注册表负责把它校验成 17 个值之一，
 * 契约本身保持规格里的形状。
 */
export interface NodeExecutorRunCtx<P = unknown> {
  readonly params: P
  readonly inputs: Record<string, unknown>
  readonly llm: LLMGateway
  readonly spans: SpanResolver
  readonly user: UserCtx
}

export interface NodeExecutor<P = unknown> {
  readonly type: string
  readonly inputs: JSONSchema
  readonly outputs: JSONSchema
  run(ctx: NodeExecutorRunCtx<P>): Promise<{ outputs: Record<string, unknown>; usage: TokenUsage }>
}

export const ZERO_USAGE: TokenUsage = { tokensIn: 0, tokensOut: 0, cachedTokens: 0 }
