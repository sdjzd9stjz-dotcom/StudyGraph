import { createHash } from 'node:crypto'
import { AppError, llmCredentialMissing, llmProviderError } from '../lib/errors.ts'
import type { ApiKeyResolver, TargetResolver } from './credentials.ts'
import { normalizeCredential } from './credentials.ts'
import { createAnthropicAgent, createAnthropicProvider } from './providers/anthropic.ts'
import { createDeepSeekProvider } from './providers/deepseek.ts'
import { createOpenAICompatibleAgent, createOpenAICompatibleProvider } from './providers/openai-compatible.ts'
import { createOpenAIProvider } from './providers/openai.ts'
import { TASK_ROUTING } from './routing.ts'
import type { ModelRoute } from './routing.ts'
import type { UserCtx } from './user.ts'
import type { LLMCompleteRequest, LLMGateway, TaskType } from './types.ts'

export interface GatewayDeps {
  /**
   * 取密钥：`(provider, user)` → 先查 BYOK（ProviderCredential 解密），再退回 .env；
   * 都没有返回 null（SG-SUP-005 缺陷 E：签名必须能拿到用户身份）。
   */
  readonly resolveEffort?: (canvasId: string, scope: string, provider: string, model: string) => Promise<string | undefined>
  readonly resolveApiKey: ApiKeyResolver
  /** 完整目标解析：协议 + baseUrl + 模型（多供应商）。不传则退回旧的三家分派。 */
  readonly resolveTarget?: TargetResolver
  /** 便于测试替换路由 */
  readonly routing?: Record<TaskType, ModelRoute>
  readonly fetchImpl?: typeof fetch
  /** 结构化日志；`cachePrefix.key` 在这里留痕（Anthropic 不把它放进请求体） */
  readonly logger?: { debug: (obj: unknown, msg?: string) => void }
}

/**
 * 统一 Gateway。前端永远不直连厂商；所有调用在这里收口：
 * 路由 → 取密钥 → 调厂商 → 回传**厂商给的** usage 与 modelVersion。
 *
 * 失败一律抛 AppError，不返回空对象——上层拿到空对象会当成"成功但没数据"，
 * 那是最难查的一类 bug。适配器抛出的 AppError（如 PROVIDER_RESPONSE_INVALID）
 * 原样上抛，不被重新包成"厂商调用失败"。
 */
function compatibleUrl(target: { baseUrl: string; protocol: string }) {
  if (target.protocol !== 'GEMINI') return target.baseUrl
  return target.baseUrl.replace(/\/+$/, '').replace(/(?:\/v1beta)?(?:\/openai)?$/, '/v1beta/openai')
}

function routingKey(userId: string, task: TaskType, model: string, conversationId?: string) {
  return 'sg-' + createHash('sha256').update(JSON.stringify(conversationId ? [userId, task, model, conversationId] : [userId, task, model])).digest('hex').slice(0, 32)
}

export function createGateway(deps: GatewayDeps, effort?: string): LLMGateway {
  const routing = deps.routing ?? TASK_ROUTING

  async function credentialsFor(task: TaskType, user: UserCtx) {
    const route = routing[task]
    if (deps.resolveTarget) {
      const target = await deps.resolveTarget(task, user, route)
      if (!target) throw llmCredentialMissing(route.provider)
      return { target, apiKey: target.apiKey }
    }
    const resolved = normalizeCredential(await deps.resolveApiKey(route.provider, user))
    if (!resolved) throw llmCredentialMissing(route.provider)
    return { target: null, apiKey: resolved.apiKey }
  }

  return {
    effort,
    async forOperation(task, user, scope) {
      const route = routing[task]
      const target = await deps.resolveTarget?.(task, user, route)
      const selected = user.canvasId && deps.resolveEffort
        ? await deps.resolveEffort(user.canvasId, scope, target?.providerSlug ?? route.provider, target?.model ?? route.model)
        : undefined
      return createGateway({ ...deps, ...(deps.resolveTarget ? { resolveTarget: async () => target ?? null } : {}) }, selected)
    },
    async selectedRoute(task, user) {
      const route = routing[task]
      const target = await deps.resolveTarget?.(task, user, route)
      if (!target || (target.providerSlug === route.provider && target.model === route.model)) return route
      return { provider: target.providerSlug, model: target.model }
    },
    routeFor: (task) => routing[task],
    async complete(request: LLMCompleteRequest) {
      const route = routing[request.taskType]
      const { target, apiKey } = await credentialsFor(request.taskType, request.user)

      // 新接口用 cachePrefix（key + text）；老调用方只给 key 时退化成 { key, text: '' }
      const cachePrefix =
        request.cachePrefix ??
        (request.cachePrefixKey ? { key: request.cachePrefixKey, text: '' } : undefined)

      // key 的可观测用途：日志与指标（Anthropic 不把它塞进请求体，这里必须留痕）
      if (cachePrefix) {
        deps.logger?.debug(
          { event: 'llm.prefix_cache', provider: route.provider, taskType: request.taskType, cachePrefixKey: cachePrefix.key, prefixChars: cachePrefix.text.length },
          '前缀缓存材料',
        )
      }

      // 有目标就按**协议**分派，而不是按厂商标识 —— 自定义 OpenAI 兼容端点
      // （校园网关、本地 Ollama、中转站）没有固定的厂商标识，只能靠协议认。
      const model = target?.model ?? route.model
      const providerLabel = target?.providerSlug ?? route.provider
      const call =
        target?.protocol === 'ANTHROPIC'
          ? createAnthropicProvider({ apiKey: target.apiKey, baseUrl: target.baseUrl, fetchImpl: deps.fetchImpl })
          : target
            ? createOpenAICompatibleProvider({
                provider: providerLabel === 'deepseek' ? 'deepseek' : 'openai',
                routingKey: routingKey(request.user.id, request.taskType, model, request.conversationId),
                jsonMode: providerLabel === 'deepseek' ? 'json_object' : 'json_schema',
                apiKey: target.apiKey,
                baseUrl: compatibleUrl(target),
                fetchImpl: deps.fetchImpl,
              })
            : route.provider === 'openai'
              ? createOpenAIProvider({ apiKey, fetchImpl: deps.fetchImpl })
              : route.provider === 'deepseek'
                ? createDeepSeekProvider({ apiKey, fetchImpl: deps.fetchImpl })
                : createAnthropicProvider({ apiKey, fetchImpl: deps.fetchImpl })

      try {
        const result = await call({
          model,
          messages: request.messages,
          jsonSchema: request.jsonSchema,
          maxTokens: request.maxTokens,
          effort,
          cacheConversation: Boolean(request.conversationId),
          cachePrefix: cachePrefix ?? { key: routingKey(request.user.id, request.taskType, model, request.conversationId), text: '' },
        })
        return { ...result, provider: providerLabel }
      } catch (error) {
        // 已经带 errorCode 的（响应结构非法等）原样上抛，不叠加成 502 厂商错误
        if (error instanceof AppError) throw error
        throw llmProviderError(providerLabel, error instanceof Error ? error.message : String(error))
      }
    },

    async chatWithTools(request) {
      const route = routing[request.taskType]
      const { target, apiKey } = await credentialsFor(request.taskType, request.user)

      const model = target?.model ?? route.model
      const providerLabel = target?.providerSlug ?? route.provider
      const agent = (target?.protocol === 'ANTHROPIC' || (!target && route.provider === 'anthropic'))
        ? createAnthropicAgent({ apiKey, baseUrl: target?.baseUrl, fetchImpl: deps.fetchImpl })
        : createOpenAICompatibleAgent({
        provider: providerLabel === 'deepseek' ? 'deepseek' : 'openai',
        routingKey: routingKey(request.user.id, request.taskType, model, request.conversationId),
        apiKey,
        baseUrl:
          target ? compatibleUrl(target) :
          (route.provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1'),
        fetchImpl: deps.fetchImpl,
      })

      try {
        const result = await agent({
          model,
          messages: request.messages,
          tools: request.tools,
          maxTokens: request.maxTokens,
          effort,
        })
        return { ...result, provider: providerLabel }
      } catch (error) {
        if (error instanceof AppError) throw error
        throw llmProviderError(providerLabel, error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/** 从环境变量取密钥（保留给自检与测试）；生产路径用 credentials.ts 的 BYOK 解析器。 */
export function envApiKeyResolver(env: Record<string, string | undefined>): ApiKeyResolver {
  return async (provider) => {
    const key = provider === 'openai' ? env.OPENAI_API_KEY : provider === 'deepseek' ? env.DEEPSEEK_API_KEY : env.ANTHROPIC_API_KEY
    return key && key.trim().length > 0 ? key.trim() : null
  }
}
