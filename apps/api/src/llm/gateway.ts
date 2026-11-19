import { llmCredentialMissing, llmProviderError } from '../lib/errors.ts'
import { createAnthropicProvider } from './providers/anthropic.ts'
import { createOpenAIProvider } from './providers/openai.ts'
import { TASK_ROUTING } from './routing.ts'
import type { ModelRoute } from './routing.ts'
import type { LLMCompleteRequest, LLMGateway, TaskType } from './types.ts'

export interface GatewayDeps {
  /** 取密钥：先查 BYOK（ProviderCredential 解密），再退回 .env；都没有返回 null */
  readonly resolveApiKey: (provider: 'openai' | 'anthropic') => Promise<string | null>
  /** 便于测试替换路由 */
  readonly routing?: Record<TaskType, ModelRoute>
  readonly fetchImpl?: typeof fetch
}

/**
 * 统一 Gateway。前端永远不直连厂商；所有调用在这里收口：
 * 路由 → 取密钥 → 调厂商 → 回传**厂商给的** usage 与 modelVersion。
 *
 * 失败一律抛 AppError，不返回空对象——上层拿到空对象会当成"成功但没数据"，
 * 那是最难查的一类 bug。
 */
export function createGateway(deps: GatewayDeps): LLMGateway {
  const routing = deps.routing ?? TASK_ROUTING

  return {
    async complete(request: LLMCompleteRequest) {
      const route = routing[request.taskType]
      const apiKey = await deps.resolveApiKey(route.provider)
      if (!apiKey) throw llmCredentialMissing(route.provider)

      const call =
        route.provider === 'openai'
          ? createOpenAIProvider({ apiKey, fetchImpl: deps.fetchImpl })
          : createAnthropicProvider({ apiKey, fetchImpl: deps.fetchImpl })

      try {
        return await call({
          model: route.model,
          messages: request.messages,
          jsonSchema: request.jsonSchema,
        })
      } catch (error) {
        throw llmProviderError(route.provider, error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/** 从环境变量取密钥；BYOK 走 ProviderCredential（M2 接上解密路径后替换这里）。 */
export function envApiKeyResolver(env: Record<string, string | undefined>): GatewayDeps['resolveApiKey'] {
  return async (provider) => {
    const key = provider === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY
    return key && key.trim().length > 0 ? key.trim() : null
  }
}
