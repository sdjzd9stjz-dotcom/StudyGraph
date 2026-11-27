import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

import type { PrismaClient } from '../../../packages/db/src/index.ts'
import type { Env } from './env.ts'
import { logServerError } from './lib/error-log.ts'
import { AppError, invalidJson, validationFailed } from './lib/errors.ts'
import { createGuard } from './plugins/auth.ts'
import { createApiKeyResolver, createTargetResolver } from './llm/credentials.ts'
import { checkEffort } from './llm/reasoning.ts'
import { createGateway } from './llm/gateway.ts'
import { registerBuiltinExecutors } from './nodes/executors/index.ts'
import { assertRegistryReady } from './nodes/registry.ts'
import { selfCheck } from './nodes/registry.ts'
import { registerAssistantRoutes } from './routes/assistant.ts'
import { registerCanvasRoutes } from './routes/canvases.ts'
import { registerAnalyticsRoutes } from './routes/analytics.ts'
import { registerAttemptRoutes } from './routes/attempts.ts'
import { registerCompatRoutes } from './routes/compat.ts'
import { registerConceptRoutes } from './routes/concepts.ts'
import { registerDraftRoutes } from './routes/drafts.ts'
import { registerEdgeRoutes } from './routes/edges.ts'
import { registerCanvasEdits } from './routes/canvas-edits.ts'
import { registerGraphRoutes } from './routes/graph.ts'
import { registerGroupRoutes } from './routes/groups.ts'
import { registerNodeRoutes } from './routes/nodes.ts'
import { registerRunRoutes } from './routes/run.ts'
import { registerRunEventRoutes } from './routes/runs.ts'
import { registerProblemRoutes } from './routes/problems.ts'
import { registerProviderRoutes } from './routes/providers.ts'
import { registerReviewRoutes } from './routes/review.ts'
import { registerFsrsReviewRoutes } from './routes/reviews.ts'
import { registerSourceRoutes } from './routes/sources.ts'
import { registerSkillRoutes } from './routes/skills.ts'
import { registerSystemRoutes } from './routes/system.ts'
import { createObjectStore } from './storage/object-store.ts'

export interface BuildAppOptions {
  readonly env: Env
  readonly prisma: PrismaClient
}

/**
 * 组装 Fastify 应用。测试用 `app.inject()` 直接打路由，不需要监听端口。
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { env, prisma } = options

  const app = Fastify({
    logger:
      env.NODE_ENV === 'test'
        ? false
        : { level: process.env.LOG_LEVEL ?? 'info', transport: undefined },
    bodyLimit: 2 * 1024 * 1024,
  })

  // 空 body 容忍：curl -X POST 带 content-type 却没给 body 时，Fastify 默认 400。
  // 对 /run、/mark-stale 这类"没有参数"的端点，这是客户端的坑而不是错误请求。
  // 坏 JSON 则必须是 400 INVALID_JSON（SG-SUP-005 G2）——客户端写错不该看到 500。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = (body as string).trim()
    if (text.length === 0) {
      done(null, {})
      return
    }
    try {
      done(null, JSON.parse(text))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      done(invalidJson(message), undefined)
    }
  })

  // ── 统一错误信封 ────────────────────────────────────────────────────────────
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send(error.toEnvelope())
    }

    // 全项目统一：Zod 校验失败一律 400 VALIDATION_FAILED，附 issues（SG-SUP-011 §4.3）
    if (error instanceof ZodError) {
      return reply.status(400).send(
        validationFailed({
          issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        }).toEnvelope(),
      )
    }

    const status = (error as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) {
      // Fastify 自带的 400（JSON 解析失败、content-type 不对）也走同一信封
      return reply
        .status(400)
        .send(validationFailed({ reason: (error as Error).message }).toEnvelope())
    }

    request.log.error({ err: error }, 'unhandled error')

    /**
     * 500 也要把真实原因带出来。
     *
     * 只说"服务器内部错误"等于什么都没说：学生无法自查，我也拿不到现场。
     * 本地桌面应用没有"泄露内部信息给第三方"的顾虑，明细比含糊有用得多。
     * 同时追加到 api-errors.log，窗口关了也能事后查。
     */
    const detail = error instanceof Error ? error.message : String(error)
    logServerError(error, { method: request.method, url: request.url, code: (error as { code?: string }).code })
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务器内部错误',
        detail: detail.slice(0, 400),
      },
    })
  })

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'CANVAS_NOT_FOUND',
        message: `路由不存在：${request.method} ${request.url}`,
      },
    })
  })

  // ── 最小 CORS（web 跑在 3000，API 在 3001）──────────────────────────────
  /**
   * 允许的头必须**回显浏览器请求的那些**，不能写死。
   *
   * 之前写死成 `authorization, content-type`，而上传课件还要带 `x-filename`：
   * 预检响应里没有它 → 浏览器直接判为不允许 → 请求根本没发出去 →
   * 前端只看到 `TypeError: Failed to fetch`，服务端日志里一行都没有。
   * 这种"什么错都看不到"的失败，最难查。
   *
   * 回显而不是继续追加白名单：以后再加自定义头（比如断点续传的 x-upload-id）
   * 不会再踩同一个坑。允许的来源仍然收窄到本机与 file://（桌面版）。
   */
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('access-control-allow-origin', request.headers.origin ?? '*')
    const requested = request.headers['access-control-request-headers']
    reply.header(
      'access-control-allow-headers',
      typeof requested === 'string' && requested.trim().length > 0
        ? requested
        : 'authorization, content-type',
    )
    /**
     * PUT 必须在列表里。
     *
     * 保存"各任务用哪个模型"走的是 `PUT /v1/preferences/:taskType`；
     * 方法不被允许时，浏览器**预检通过但真正请求被拦下**，
     * 前端只会看到一次失败的 fetch —— 表现就是"选完又变回默认路由"，
     * 而且在服务端日志里只看得到 OPTIONS，看不到 PUT（实际遇到过）。
     */
    reply.header('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
    return payload
  })
  app.options('/*', async (_request, reply) => reply.status(204).send())

  // ── 健康检查（不鉴权）──────────────────────────────────────────────────
  // 数据库不可达时**必须返回 5xx**：桌面客户端主进程按状态码判断"真的能用了"，
  // 如果这里仍返回 200，库挂掉时窗口会打开在错误页上，用户看到的是"软件坏了"而不是"数据库没起来"。
  app.get('/health', async (_request, reply) => {
    try {
      await prisma.$queryRaw`select 1`
      return { status: 'ok', db: 'up' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      reply.code(503)
      return { status: 'degraded', db: 'down', detail: message.slice(0, 200) }
    }
  })

  // ── 启动自检（SG-SUP-005 缺陷 C：不通过就拒绝启动）────────────────────
  registerBuiltinExecutors()
  const registryReport = selfCheck()
  if (!registryReport.ok) {
    app.log.error({ problems: registryReport.problems }, '执行器注册表自检未通过')
    throw new Error(`执行器注册表自检未通过：\n- ${registryReport.problems.join('\n- ')}`)
  }
  app.log.info(
    {
      implemented: registryReport.implemented,
      planned: registryReport.planned.length,
      unionSize: registryReport.unionSize,
    },
    '执行器注册表自检通过',
  )

  // ── 业务路由 ───────────────────────────────────────────────────────────
  const guard = createGuard(prisma)
  const objectStore = createObjectStore({
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: true,
    localRoot: env.STUDYGRAPH_OBJECT_DIR,
  })

  // BYOK：按 userId 查 ProviderCredential → 解密；没有则回退 env；都没有 → null
  const resolveApiKey = createApiKeyResolver({
    prisma,
    masterKey: env.BYOK_ENCRYPTION_KEY,
    env: {
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
    },
  })

  const resolveTarget = createTargetResolver({ prisma, masterKey: env.BYOK_ENCRYPTION_KEY, env: { OPENAI_API_KEY: env.OPENAI_API_KEY, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY } })
  const llm = createGateway({
    resolveApiKey,
    resolveTarget,
    async resolveEffort(canvasId, scope, provider, model) {
      const pref = await prisma.canvasReasoningPref.findUnique({ where: { canvasId_scope: { canvasId, scope } } })
      if (!pref || pref.provider !== provider || pref.model !== model) return undefined
      await checkEffort(prisma, provider, model, pref.effort)
      return pref.effort
    },
    logger: { debug: (obj, msg) => app.log.debug(obj, msg) },
  })

  registerCanvasRoutes(app, { prisma, guard, objectStore, llm })
  registerNodeRoutes(app, { prisma, guard })
  registerEdgeRoutes(app, { prisma, guard })
  registerCanvasEdits(app, { prisma, guard })
  registerDraftRoutes(app, { prisma, guard, llm })
  registerGraphRoutes(app, { prisma, guard })
  registerGroupRoutes(app, { prisma, guard, llm })
  registerAssistantRoutes(app, { prisma, guard, llm })
  registerRunRoutes(app, { prisma, guard, objectStore, llm })
  registerRunEventRoutes(app, { prisma, guard })
  registerSystemRoutes(app, { guard, resolveApiKey })
  registerSkillRoutes(app, { prisma, guard })
  registerCompatRoutes(app, { prisma, guard, resolveTarget, masterKey: env.BYOK_ENCRYPTION_KEY })
  registerAnalyticsRoutes(app, { prisma, guard })
  registerAttemptRoutes(app, { prisma, guard })
  registerReviewRoutes(app, { prisma, guard })
  registerFsrsReviewRoutes(app, { prisma, guard })
  registerConceptRoutes(app, { prisma, guard, objectStore })
  registerSourceRoutes(app, { prisma, guard, objectStore })
  registerProviderRoutes(app, { prisma, guard, masterKey: env.BYOK_ENCRYPTION_KEY })
  registerProblemRoutes(app, { prisma, guard })

  return app
}
