import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

import type { PrismaClient } from '../../../packages/db/src/index.ts'
import type { Env } from './env.ts'
import { AppError, invalidJson, validationFailed } from './lib/errors.ts'
import { createGuard } from './plugins/auth.ts'
import { createApiKeyResolver } from './llm/credentials.ts'
import { createGateway } from './llm/gateway.ts'
import { registerBuiltinExecutors } from './nodes/executors/index.ts'
import { assertRegistryReady } from './nodes/registry.ts'
import { selfCheck } from './nodes/registry.ts'
import { registerCanvasRoutes } from './routes/canvases.ts'
import { registerEdgeRoutes } from './routes/edges.ts'
import { registerGraphRoutes } from './routes/graph.ts'
import { registerNodeRoutes } from './routes/nodes.ts'
import { registerRunRoutes } from './routes/run.ts'
import { registerReviewRoutes } from './routes/review.ts'
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
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
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
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('access-control-allow-origin', request.headers.origin ?? '*')
    reply.header('access-control-allow-headers', 'authorization, content-type')
    reply.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    return payload
  })
  app.options('/*', async (_request, reply) => reply.status(204).send())

  // ── 健康检查（不鉴权）──────────────────────────────────────────────────
  app.get('/health', async () => {
    try {
      await prisma.$queryRaw`select 1`
      return { status: 'ok', db: 'up' }
    } catch {
      return { status: 'degraded', db: 'down' }
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

  const llm = createGateway({
    resolveApiKey,
    logger: { debug: (obj, msg) => app.log.debug(obj, msg) },
  })

  registerCanvasRoutes(app, { prisma, guard, objectStore })
  registerNodeRoutes(app, { prisma, guard })
  registerEdgeRoutes(app, { prisma, guard })
  registerGraphRoutes(app, { prisma, guard })
  registerRunRoutes(app, { prisma, guard, objectStore, llm })
  registerSystemRoutes(app, { guard, resolveApiKey })
  registerReviewRoutes(app, { prisma, guard })

  return app
}
