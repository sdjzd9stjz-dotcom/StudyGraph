import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { decryptSecret } from './byok.ts'
import type { UserCtx } from './user.ts'

/**
 * BYOK 凭据解析（SG-SUP-005 缺陷 E）。
 *
 * 顺序：
 *   1. 用户自己的 `ProviderCredential`（按 userId + provider，取最新的启用记录）
 *   2. 环境变量 `.env`（校园/开发额度）
 *   3. 都没有 → 返回 null，由 Gateway 抛 `LLM_CREDENTIAL_MISSING`
 *
 * 约束：
 * - 解密后**只在内存里存活**，不进日志、不进错误信息
 * - 主密钥缺失时**拒绝解密**（byok.ts 会抛），不会退化成明文，也不会悄悄回退到 env
 */
export interface ResolvedCredential {
  readonly apiKey: string
  readonly source: 'byok' | 'env'
}

export interface CredentialResolverDeps {
  readonly prisma: PrismaClient
  readonly masterKey?: string | undefined
  readonly env: {
    readonly OPENAI_API_KEY?: string | undefined
    readonly ANTHROPIC_API_KEY?: string | undefined
    readonly DEEPSEEK_API_KEY?: string | undefined
  }
}

/** 允许返回纯字符串（老调用方/测试）或带来源的对象。 */
export type ApiKeyResult = string | ResolvedCredential | null

export type ApiKeyResolver = (
  // 供应商来自数据表，标识是开放字符串（含学生自建的 custom-xxx）
  provider: string,
  user: UserCtx,
) => Promise<ApiKeyResult>

export function createApiKeyResolver(deps: CredentialResolverDeps): ApiKeyResolver {
  return async function resolveApiKey(provider, user) {
    /**
     * 读的是 `UserCredential`，**不是** `ProviderCredential`。
     *
     * 库里有两张凭据表：`ProviderCredential` 是最早的占位设计（`provider` 存字符串），
     * 界面的 BYOK 写入 `UserCredential`（外键到 Provider 表，带 baseUrlOverride）。
     * 这里曾经查旧表 —— 那张表永远是空的，于是用户明明保存了密钥，
     * 运行节点却报"没有可用的 deepseek 凭据"（实际遇到过）。
     * 旧表已无写入方，保留只为不破坏历史迁移。
     */
    const providerRow = await deps.prisma.provider.findUnique({
      where: { slug: provider },
      select: { id: true },
    })
    const credential = providerRow
      ? await deps.prisma.userCredential.findFirst({
          where: { userId: user.id, providerId: providerRow.id, isActive: true },
          orderBy: { createdAt: 'desc' },
        })
      : null

    if (credential) {
      if (!deps.masterKey) {
        // 有密文但没有主密钥：配置错误必须报出来
        throw new Error('存在已保存的密钥，但 BYOK_ENCRYPTION_KEY 未配置，无法解密')
      }
      return { apiKey: decryptSecret(credential.ciphertext, deps.masterKey), source: 'byok' }
    }

    const fromEnv =
      provider === 'openai'
        ? deps.env.OPENAI_API_KEY
        : provider === 'deepseek'
          ? deps.env.DEEPSEEK_API_KEY
          : deps.env.ANTHROPIC_API_KEY
    const trimmed = fromEnv?.trim()
    return trimmed && trimmed.length > 0 ? { apiKey: trimmed, source: 'env' } : null
  }
}

/** 统一把 string / 对象 / null 归一成 `{ apiKey, source }` 或 null。 */
export function normalizeCredential(result: ApiKeyResult): ResolvedCredential | null {
  if (result === null || result === undefined) return null
  if (typeof result === 'string') return result.length > 0 ? { apiKey: result, source: 'env' } : null
  return result.apiKey.length > 0 ? result : null
}

// ═══════════════════════════════════════════════════════════════════════════
// 完整调用目标（多供应商）
//
// 为什么还要这一层：`resolveApiKey` 只回答"密钥是什么"，回答了"发给谁、用哪个模型"。
// 自定义 OpenAI 兼容端点（校园网关、本地 Ollama、中转站）没有固定 slug，
// 必须带上协议与 baseUrl 才能发请求，否则自定义端点根本用不上。
// ═══════════════════════════════════════════════════════════════════════════

export type ProviderProtocolName = 'OPENAI' | 'ANTHROPIC' | 'GEMINI'

export interface ResolvedTarget {
  readonly apiKey: string
  readonly source: 'byok' | 'env'
  readonly protocol: ProviderProtocolName
  readonly baseUrl: string
  readonly model: string
  readonly providerSlug: string
  readonly providerName: string
  /** 用户为该任务显式指定过模型 → true；用于界面提示"你在用自定义配置" */
  readonly fromPreference: boolean
}

export interface TargetResolverDeps {
  readonly prisma: PrismaClient
  readonly masterKey?: string | undefined
  readonly env: {
    readonly OPENAI_API_KEY?: string | undefined
    readonly ANTHROPIC_API_KEY?: string | undefined
    readonly DEEPSEEK_API_KEY?: string | undefined
  }
}

/** 环境变量兜底时用的端点与协议（与预置目录保持一致） */
const ENV_FALLBACK: Record<string, { protocol: ProviderProtocolName; baseUrl: string; name: string }> = {
  openai: { protocol: 'OPENAI', baseUrl: 'https://api.openai.com/v1', name: 'OpenAI' },
  deepseek: { protocol: 'OPENAI', baseUrl: 'https://api.deepseek.com', name: 'DeepSeek' },
  anthropic: { protocol: 'ANTHROPIC', baseUrl: 'https://api.anthropic.com', name: 'Anthropic' },
}

/**
 * 解析出"这条任务该发给谁"。
 *
 * 顺序（规格「三个产品问题」②）：
 *   1. 用户为该 taskType 指定的模型偏好 —— 完全覆盖默认路由（含自定义端点）
 *   2. 默认路由对应的厂商 + 该用户在这个厂商下的凭据
 *   3. 环境变量（平台额度）
 *   4. 都没有 → null，由 Gateway 抛 NO_MODEL_CONFIGURED
 *
 * **绝不**在没配好时静默返回一个假结果。
 */
export function createTargetResolver(deps: TargetResolverDeps) {
  const decrypt = (ciphertext: string): string => {
    if (!deps.masterKey) throw new Error('存在已保存的密钥，但主密钥未配置，无法解密')
    return decryptSecret(ciphertext, deps.masterKey)
  }

  return async function resolveTarget(
    taskType: string,
    user: UserCtx,
    defaultRoute: { provider: string; model: string },
  ): Promise<ResolvedTarget | null> {
    // 0. 画布级配置优先：这块画布显式指定了模型，就按它来（用户要求 AI 配置每块画布独立）
    if (user.canvasId) {
      const canvasPref = await deps.prisma.canvasModelPref.findUnique({
        where: { canvasId_taskType: { canvasId: user.canvasId, taskType } },
        include: { credential: { include: { provider: true } } },
      })
      if (canvasPref && canvasPref.credential.isActive) {
        const credential = canvasPref.credential
        return {
          apiKey: decrypt(credential.ciphertext),
          source: 'byok',
          protocol: credential.provider.protocol as ProviderProtocolName,
          baseUrl: credential.baseUrlOverride ?? credential.provider.baseUrl,
          model: canvasPref.modelId,
          providerSlug: credential.provider.slug,
          providerName: credential.provider.name,
          fromPreference: true,
        }
      }
    }

    // 1. 用户偏好
    const pref = await deps.prisma.userModelPref.findUnique({
      where: { userId_taskType: { userId: user.id, taskType } },
      include: { credential: { include: { provider: true } } },
    })
    if (pref && pref.credential.isActive) {
      const credential = pref.credential
      return {
        apiKey: decrypt(credential.ciphertext),
        source: 'byok',
        protocol: credential.provider.protocol as ProviderProtocolName,
        baseUrl: credential.baseUrlOverride ?? credential.provider.baseUrl,
        model: pref.modelId,
        providerSlug: credential.provider.slug,
        providerName: credential.provider.name,
        fromPreference: true,
      }
    }

    // 2. 默认路由厂商 + 该用户下的凭据
    const provider = await deps.prisma.provider.findUnique({ where: { slug: defaultRoute.provider } })
    if (provider) {
      const credential = await deps.prisma.userCredential.findFirst({
        where: { userId: user.id, providerId: provider.id, isActive: true },
        orderBy: { createdAt: 'desc' },
      })
      if (credential) {
        return {
          apiKey: decrypt(credential.ciphertext),
          source: 'byok',
          protocol: provider.protocol as ProviderProtocolName,
          baseUrl: credential.baseUrlOverride ?? provider.baseUrl,
          model: defaultRoute.model,
          providerSlug: provider.slug,
          providerName: provider.name,
          fromPreference: false,
        }
      }
    }

    // 3. 环境变量
    const envKey =
      defaultRoute.provider === 'openai'
        ? deps.env.OPENAI_API_KEY
        : defaultRoute.provider === 'deepseek'
          ? deps.env.DEEPSEEK_API_KEY
          : deps.env.ANTHROPIC_API_KEY
    const trimmed = envKey?.trim()
    if (trimmed) {
      const fallback = ENV_FALLBACK[defaultRoute.provider] ?? ENV_FALLBACK.openai!
      return {
        apiKey: trimmed,
        source: 'env',
        protocol: fallback.protocol,
        baseUrl: fallback.baseUrl,
        model: defaultRoute.model,
        providerSlug: defaultRoute.provider,
        providerName: fallback.name,
        fromPreference: false,
      }
    }

    return null
  }
}

export type TargetResolver = ReturnType<typeof createTargetResolver>
