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
  provider: 'openai' | 'anthropic' | 'deepseek',
  user: UserCtx,
) => Promise<ApiKeyResult>

export function createApiKeyResolver(deps: CredentialResolverDeps): ApiKeyResolver {
  return async function resolveApiKey(provider, user) {
    const credential = await deps.prisma.providerCredential.findFirst({
      where: { userId: user.id, provider, isActive: true },
      orderBy: { createdAt: 'desc' },
    })

    if (credential) {
      if (!deps.masterKey) {
        // 有密文但没有主密钥：配置错误必须报出来
        throw new Error('存在 ProviderCredential，但 BYOK_ENCRYPTION_KEY 未配置，无法解密')
      }
      return { apiKey: decryptSecret(credential.keyCiphertext, deps.masterKey), source: 'byok' }
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
