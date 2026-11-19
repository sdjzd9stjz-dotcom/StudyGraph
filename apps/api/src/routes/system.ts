import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { ApiKeyResolver } from '../llm/credentials.ts'
import { normalizeCredential } from '../llm/credentials.ts'
import { llmCredentialMissing } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

const querySchema = z.object({
  provider: z.enum(['openai', 'anthropic']).default('openai'),
})

export interface SystemRouteDeps {
  readonly guard: Guard
  readonly resolveApiKey: ApiKeyResolver
}

export function registerSystemRoutes(app: FastifyInstance, deps: SystemRouteDeps): void {
  const { guard, resolveApiKey } = deps

  /**
   * 凭据探测：只回答"有没有、从哪来"，**绝不回显密钥**。
   *
   * 这条路由的存在本身就是 BYOK 接线在生产路径上的调用方：
   * `resolveApiKey` → `ProviderCredential` 查库 → `decryptSecret`。
   */
  app.get('/v1/system/credential', { preHandler: guard('RUN_EXECUTE') }, async (request) => {
    const auth = getAuth(request)
    const { provider } = parse(querySchema, request.query)

    const credential = normalizeCredential(await resolveApiKey(provider, auth.user))
    if (!credential) throw llmCredentialMissing(provider)

    return {
      provider,
      configured: true,
      source: credential.source,
      // 只给长度与末四位，密钥本身永不出现在响应里
      apiKeyLength: credential.apiKey.length,
      apiKeyLast4: credential.apiKey.slice(-4),
    }
  })
}
