/**
 * Personal Access Token 的生成与哈希。
 *
 * 硬约束（SG-SUP-003 §2.3 约束 B）：
 *   - 明文格式 `sg_pat_<32 字节 base64url>`，**只在创建时返回一次**
 *   - 库里存 sha256(明文) 的十六进制
 *   - tokenPrefix 存前缀后的前 8 位，供 UI 展示与吊销
 *   - 校验按 hash 查表；明文不进库、不回显
 */
import { createHash, randomBytes } from 'node:crypto'

export const PAT_PREFIX = 'sg_pat_'
export const PREFIX_DISPLAY_LENGTH = 8

export interface IssuedToken {
  /** 明文：只应出现在创建时的输出里 */
  readonly token: string
  readonly tokenHash: string
  readonly tokenPrefix: string
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function issueToken(): IssuedToken {
  const token = PAT_PREFIX + randomBytes(32).toString('base64url')
  return {
    token,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(PAT_PREFIX.length, PAT_PREFIX.length + PREFIX_DISPLAY_LENGTH),
  }
}

/** 只做形态初筛，真正的判据是库里的 hash 命中。 */
export function looksLikePat(value: string): boolean {
  return value.startsWith(PAT_PREFIX) && value.length > PAT_PREFIX.length + 8
}

/** scope 的展示名：库里存 CANVAS_READ，对外说 canvas:read（规格里的写法）。 */
export const SCOPE_LABELS = {
  CANVAS_READ: 'canvas:read',
  CANVAS_WRITE: 'canvas:write',
  RUN_EXECUTE: 'run:execute',
  PROBLEM_READ: 'problem:read',
} as const

export type ScopeName = keyof typeof SCOPE_LABELS

export function scopeLabel(scope: ScopeName): string {
  return SCOPE_LABELS[scope]
}
