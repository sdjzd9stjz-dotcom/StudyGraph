import type { JSONSchema, LLMGateway, TokenUsage } from '../llm/types.ts'
import type { UserCtx } from '../llm/user.ts'
import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import type { SpanResolver } from '../spans/resolver.ts'
import type { ObjectStore } from '../storage/object-store.ts'

/**
 * 节点执行器契约（规格原文，字段名不许改）。
 *
 * 注意 `type` 是 string 而不是 NodeType：注册表负责把它校验成 17 个值之一，
 * 契约本身保持规格里的形状。
 *
 * 在规格规定的 `params / inputs / llm / spans / user` 之外，额外挂了
 * `prisma / canvasId / nodeId / objectStore`——executor 必须能读库、落产物、写对象存储。
 * 这些是**新增字段**，规格里已有的字段名一个没动。
 */
export interface NodeExecutorRunCtx<P = unknown> {
  readonly params: P
  readonly inputs: Record<string, unknown>
  readonly llm: LLMGateway
  readonly spans: SpanResolver
  readonly user: UserCtx
  readonly prisma: PrismaClient
  readonly canvasId: string
  readonly nodeId: string
  readonly objectStore: ObjectStore
}

export interface NodeExecutor<P = unknown> {
  readonly type: string
  readonly inputs: JSONSchema
  readonly outputs: JSONSchema
  /** 产物类型（ArtifactKind 的字符串值），由跑批器写入 Artifact */
  readonly artifactKind: string
  /** prompt 模板文本的哈希；无 prompt 的执行器写 'no-prompt' */
  readonly promptVersion: string
  run(ctx: NodeExecutorRunCtx<P>): Promise<{ outputs: Record<string, unknown>; usage: TokenUsage }>
}

export const ZERO_USAGE: TokenUsage = { tokensIn: 0, tokensOut: 0, cachedTokens: 0 }
