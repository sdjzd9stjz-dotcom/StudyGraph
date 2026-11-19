import { AppError, llmCredentialMissing, llmProviderError } from '../lib/errors.ts'
import type { ApiKeyResolver } from './credentials.ts'
import { normalizeCredential } from './credentials.ts'
import { createAnthropicProvider } from './providers/anthropic.ts'
import { createOpenAIProvider } from './providers/openai.ts'
import { TASK_ROUTING } from './routing.ts'
import type { ModelRoute } from './routing.ts'
import type { LLMCompleteRequest, LLMGateway, TaskType } from './types.ts'

export interface GatewayDeps {
  /**
   * 取密钥：`(provider, user)` → 先查 BYOK（ProviderCredential 解密），再退回 .env；
   * 都没有返回 null（SG-SUP-005 缺陷 E：签名必须能拿到用户身份）。
   */
  readonly resolveApiKey: ApiKeyResolver
  /** 便于测试替换路由 */
  readonly routing?: Record<TaskType, ModelRoute>
  readonly fetchImpl?: typeof fetch
}

/**
 * 统一 Gateway。前端永远不直连厂商；所有调用在这里收口：
 * 路由 → 取密钥 → 调厂商 → 回传**厂商给的** usage 与 modelVersion。
 *
 * 失败一律抛 AppError，不返回空对象——上层拿到空对象会当成"成功但没数据"，
 * 那是最难查的一类 bug。适配器抛出的 AppError（如 PROVIDER_RESPONSE_INVALID）
 * 原样上抛，不被重新包成"厂商调用失败"。
 */
export function createGateway(deps: GatewayDeps): LLMGateway {
  const routing = deps.routing ?? TASK_ROUTING

  return {
    async complete(request: LLMCompleteRequest) {
      const route = routing[request.taskType]
      const resolved = normalizeCredential(await deps.resolveApiKey(route.provider, request.user))
      if (!resolved) throw llmCredentialMissing(route.provider)
      const apiKey = resolved.apiKey

      const call =
        route.provider === 'openai'
          ? createOpenAIProvider({ apiKey, fetchImpl: deps.fetchImpl })
          : createAnthropicProvider({ apiKey, fetchImpl: deps.fetchImpl })

      try {
        return await call({
          model: route.model,
          messages: request.messages,
          jsonSchema: request.jsonSchema,
          cachePrefixKey: request.cachePrefixKey,
        })
      } catch (error) {
        // 已经带 errorCode 的（响应结构非法等）原样上抛，不叠加成 502 厂商错误
        if (error instanceof AppError) throw error
        throw llmProviderError(route.provider, error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/** 从环境变量取密钥（保留给自检与测试）；生产路径用 credentials.ts 的 BYOK 解析器。 */
export function envApiKeyResolver(env: Record<string, string | undefined>): ApiKeyResolver {
  return async (provider) => {
    const key = provider === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY
    return key && key.trim().length > 0 ? key.trim() : null
  }
}
