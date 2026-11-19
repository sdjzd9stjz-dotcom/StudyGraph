/**
 * 全站统一错误信封：`{ error: { code, message, details? } }`（SG-SUP-003 §3.1）
 *
 * errorCode 是给机器和"学生排查"用的，不是给人读的小说：
 * 401（没登录）与 403（没权限）必须分开，见 SG-SUP-003 §2.4。
 */

export const ERROR_CODES = [
  // 鉴权
  'UNAUTHENTICATED',
  'TOKEN_REVOKED',
  'TOKEN_EXPIRED',
  'INSUFFICIENT_SCOPE',
  // 画布
  'CANVAS_NOT_FOUND',
  'CANVAS_ID_IN_BODY',
  'FORBIDDEN',
  // 节点
  'NODE_NOT_FOUND',
  'NODE_TYPE_INVALID',
  'NODE_PARAMS_INVALID',
  'NODE_NOT_IN_CANVAS',
  // 边
  'EDGE_SELF_LOOP',
  'EDGE_PORT_NOT_FOUND',
  'EDGE_PORT_EXTERNAL',
  'EDGE_PORT_TYPE_MISMATCH',
  'EDGE_DUPLICATE',
  // 视图
  'VIEW_NOT_IMPLEMENTED',
  // 执行（M2）
  'EXECUTOR_NOT_IMPLEMENTED',
  'LLM_CREDENTIAL_MISSING',
  'LLM_PROVIDER_ERROR',
  'PROVIDER_RESPONSE_INVALID',
  'SOURCE_HAS_NO_TEXT_LAYER',
  'SOURCE_TEXT_LAYER_UNUSABLE',
  // 通用
  'VALIDATION_FAILED',
  'INVALID_JSON',
  'INTERNAL_ERROR',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export class AppError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(status: number, code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }

  toEnvelope(): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    return this.details
      ? { error: { code: this.code, message: this.message, details: this.details } }
      : { error: { code: this.code, message: this.message } }
  }
}

/** 401：没登录 / token 不存在。 */
export const unauthenticated = (message = '缺少或无效的 Authorization 头') =>
  new AppError(401, 'UNAUTHENTICATED', message)

export const tokenRevoked = () => new AppError(401, 'TOKEN_REVOKED', 'Token 已被吊销')

export const tokenExpired = () => new AppError(401, 'TOKEN_EXPIRED', 'Token 已过期')

/** 403：登录了，但 scope 不够。**不要写成 401**。 */
export const insufficientScope = (required: string, granted: readonly string[]) =>
  new AppError(403, 'INSUFFICIENT_SCOPE', `缺少所需 scope：${required}`, {
    required,
    granted,
  })

export const canvasNotFound = (canvasId: string) =>
  new AppError(404, 'CANVAS_NOT_FOUND', '画布不存在或无权访问', { canvasId })

export const forbidden = (message: string, details?: Record<string, unknown>) =>
  new AppError(403, 'FORBIDDEN', message, details)

export const canvasIdInBody = () =>
  new AppError(400, 'CANVAS_ID_IN_BODY', 'canvasId 只能从路径取，不能放在请求体里')

export const nodeNotFound = (nodeId: string) => new AppError(404, 'NODE_NOT_FOUND', '节点不存在', { nodeId })

export const nodeTypeInvalid = (type: unknown, allowed: readonly string[]) =>
  new AppError(400, 'NODE_TYPE_INVALID', `未知节点类型：${String(type)}`, { type, allowed })

export const nodeParamsInvalid = (reason: string) =>
  new AppError(400, 'NODE_PARAMS_INVALID', `params 非法：${reason}`)

export const nodeNotInCanvas = (canvasId: string, nodeIds: readonly string[]) =>
  new AppError(400, 'NODE_NOT_IN_CANVAS', '节点不存在或不属于该画布', { canvasId, nodeIds })

export const edgeSelfLoop = (nodeId: string) =>
  new AppError(400, 'EDGE_SELF_LOOP', '边不能指向自身', { nodeId })

export const edgeDuplicate = (details: Record<string, unknown>) =>
  new AppError(409, 'EDGE_DUPLICATE', '这条边已存在', details)

export const viewNotImplemented = (view: string, plan: string) =>
  new AppError(501, 'VIEW_NOT_IMPLEMENTED', `视图 ${view} 尚未实现（计划：${plan}）`, { view, plan })

export const validationFailed = (details: Record<string, unknown>) =>
  new AppError(400, 'VALIDATION_FAILED', '请求参数校验失败', details)

/** 未实现的节点被调用：501，不许静默返回空对象。 */
export const executorNotImplemented = (type: string, plan: string) =>
  new AppError(501, 'EXECUTOR_NOT_IMPLEMENTED', `节点 ${type} 的 executor 尚未实现（计划：${plan}）`, {
    type,
    plan,
  })

/** 没有可用凭据：503（配置问题，不是客户端的错），且绝不能伪装成成功。 */
export const llmCredentialMissing = (provider: string) =>
  new AppError(503, 'LLM_CREDENTIAL_MISSING', `没有可用的 ${provider} 凭据：请在 .env 配置 API key，或通过 BYOK 上传`, {
    provider,
  })

export const llmProviderError = (provider: string, message: string) =>
  new AppError(502, 'LLM_PROVIDER_ERROR', `${provider} 调用失败：${message}`, { provider })

/**
 * 厂商响应缺 usage / model（SG-SUP-005 缺陷 D）。
 * 不许"缺了就当 0"：那会让额度计量与指纹的 modelVersion 同时失真。
 */
export const providerResponseInvalid = (provider: string, missing: readonly string[]) =>
  new AppError(
    502,
    'PROVIDER_RESPONSE_INVALID',
    `${provider} 响应缺少或含非法字段：${missing.join(', ')}`,
    { provider, missing },
  )

/** 客户端发了坏 JSON：400，不是 500。 */
export const invalidJson = (reason: string) =>
  new AppError(400, 'INVALID_JSON', `请求体不是合法 JSON：${reason}`)

/** 扫描版 PDF：明确告诉学生为什么不能解析，而不是静默产出空卡。 */
export const sourceHasNoTextLayer = (filename: string) =>
  new AppError(
    422,
    'SOURCE_HAS_NO_TEXT_LAYER',
    `这份 PDF 没有文字层（可能是扫描件），M2 暂不支持 OCR：${filename}`,
    { filename },
  )

/**
 * 有文字层，但文字不可用（SG-SUP-008 §2.3）。
 *
 * 与"没有文字层"分开：这是劣质 OCR 的产物，字符能读但不是人话。
 * 如果放行，下游会抽出"看着像概念、引用一段乱码"的假卡——约束 1 在这类材料面前会失效。
 */
export const sourceTextLayerUnusable = (
  filename: string,
  detail: { totalPages: number; nonEmptyPages: number; signals: string[] },
) =>
  new AppError(
    422,
    'SOURCE_TEXT_LAYER_UNUSABLE',
    `这份文件的文字层不可用（${detail.totalPages} 页中只有 ${detail.nonEmptyPages} 页能识别出零星字符，且内容多为乱码）。这通常是扫描件经过劣质 OCR 的结果。可以换一份电子版课件，或等后续版本支持重新 OCR。`,
    { filename, ...detail },
  )
