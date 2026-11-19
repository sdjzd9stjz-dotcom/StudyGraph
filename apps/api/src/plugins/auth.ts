/**
 * PAT 鉴权 + scope 守卫（SG-SUP-003 §2）。
 *
 * 401 与 403 必须分清：
 *   没头 / token 不存在 → 401 UNAUTHENTICATED
 *   已吊销 → 401 TOKEN_REVOKED
 *   已过期 → 401 TOKEN_EXPIRED
 *   有效但缺 scope → 403 INSUFFICIENT_SCOPE
 */
import type { FastifyRequest } from 'fastify'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { insufficientScope, tokenExpired, tokenRevoked, unauthenticated } from '../lib/errors.ts'
import type { ScopeName } from '../lib/pat.ts'
import { hashToken, looksLikePat, scopeLabel } from '../lib/pat.ts'

export interface AuthContext {
  readonly user: { id: string; email: string; displayName: string }
  readonly scopes: readonly ScopeName[]
  readonly tokenId: string
}

const AUTH_KEY = Symbol.for('studygraph.auth')

export function getAuth(request: FastifyRequest): AuthContext {
  const auth = (request as unknown as Record<symbol, AuthContext | undefined>)[AUTH_KEY]
  if (!auth) throw unauthenticated('该路由未挂鉴权守卫')
  return auth
}

export type Guard = (scope: ScopeName) => (request: FastifyRequest) => Promise<void>

export function createGuard(prisma: PrismaClient): Guard {
  return function guard(scope: ScopeName) {
    return async function run(request: FastifyRequest): Promise<void> {
      const header = request.headers.authorization
      if (!header || !header.toLowerCase().startsWith('bearer ')) {
        throw unauthenticated()
      }

      const token = header.slice('bearer '.length).trim()
      if (!looksLikePat(token)) throw unauthenticated()

      const record = await prisma.personalAccessToken.findUnique({
        where: { tokenHash: hashToken(token) },
        include: { user: true },
      })
      if (!record) throw unauthenticated()
      if (record.revokedAt) throw tokenRevoked()
      if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) throw tokenExpired()

      const auth: AuthContext = {
        user: { id: record.user.id, email: record.user.email, displayName: record.user.displayName },
        scopes: record.scopes as ScopeName[],
        tokenId: record.id,
      }

      // 记录使用时间；失败不影响鉴权结论
      await prisma.personalAccessToken
        .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined)

      ;(request as unknown as Record<symbol, AuthContext>)[AUTH_KEY] = auth

      if (!auth.scopes.includes(scope)) {
        throw insufficientScope(scopeLabel(scope), auth.scopes.map(scopeLabel))
      }
    }
  }
}
