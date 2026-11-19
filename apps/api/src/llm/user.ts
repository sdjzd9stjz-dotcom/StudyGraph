/** 执行上下文里的用户，与 HTTP 层的 AuthContext.user 同形。 */
export interface UserCtx {
  readonly id: string
  readonly email: string
  readonly displayName: string
}
