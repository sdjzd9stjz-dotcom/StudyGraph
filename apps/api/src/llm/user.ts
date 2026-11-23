/** 执行上下文里的用户，与 HTTP 层的 AuthContext.user 同形。 */
export interface UserCtx {
  readonly id: string
  readonly email: string
  readonly displayName: string
  /**
   * 当前所在的画布（可选）。
   *
   * 有它才能应用"这块画布自己的模型配置"：用户要求 AI 配置每块画布独立，
   * 而 resolver 只拿到 (taskType, user)，光靠用户维度无法区分是哪块画布。
   */
  readonly canvasId?: string
}
