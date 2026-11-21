import type { FastifyInstance } from 'fastify'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { findCanvasForUser } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

/**
 * `GET /v1/runs/:id/events` —— 运行事件流（M4 · SSE）。
 *
 * 现状：M2 的执行是**同步**的，`POST /nodes/:id/run` 返回时已经跑完。
 * 所以这个流通常是"补发已经发生的事"，而不是实时推送。仍然实现它，
 * 是因为契约要求客户端只用一条通道就能同时处理同步与将来的异步执行：
 *
 *   · 若运行已结束 → 立刻发一个终态事件并关闭连接
 *   · 若还在 QUEUED/RUNNING → 每 500ms 查一次库，状态变化就推
 *
 * 不做假事件：没有 QUEUED→RUNNING 这种中间态就不编造，
 * 客户端因此不能假设一定会收到"开始时"的事件。
 */

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED'])

export interface RunEventRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
}

export function registerRunEventRoutes(app: FastifyInstance, deps: RunEventRouteDeps): void {
  const { prisma, guard } = deps

  app.get('/v1/runs/:id/events', { preHandler: guard('CANVAS_READ') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }

    const run = await prisma.run.findUnique({
      where: { id },
      select: {
        id: true,
        nodeId: true,
        status: true,
        cacheHit: true,
        tokensIn: true,
        tokensOut: true,
        errorCode: true,
        errorMessage: true,
        startedAt: true,
        endedAt: true,
        node: { select: { canvasId: true } },
      },
    })
    if (!run) throw new AppError(404, 'RUN_NOT_FOUND', '运行记录不存在')

    // 无权访问画布 → 404（不泄露运行是否存在）
    await findCanvasForUser(prisma, run.node.canvasId, auth.user.id)

    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 关掉反向代理的缓冲，否则事件会被攒到最后才到
      'x-accel-buffering': 'no',
    })

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    const snapshot = async () => {
      const current = await prisma.run.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          cacheHit: true,
          tokensIn: true,
          tokensOut: true,
          errorCode: true,
          errorMessage: true,
          startedAt: true,
          endedAt: true,
        },
      })
      return current
    }

    let closed = false
    const finish = () => {
      if (closed) return
      closed = true
      res.end()
    }
    request.raw.on('close', finish)

    send('run.snapshot', { runId: run.id, status: run.status, cacheHit: run.cacheHit })

    let lastStatus = run.status
    if (TERMINAL.has(run.status)) {
      send('run.terminal', await snapshot())
      finish()
      return
    }

    // 未结束：轮询到终态或超时（同步执行下这通常 1–2 次就结束）
    const deadline = Date.now() + 120_000
    while (!closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (closed) return
      const current = await snapshot()
      if (!current) {
        finish()
        return
      }
      if (current.status !== lastStatus) {
        lastStatus = current.status
        send('run.status', current)
      }
      if (TERMINAL.has(current.status)) {
        send('run.terminal', current)
        finish()
        return
      }
    }

    if (!closed) {
      send('run.timeout', { runId: id, status: lastStatus })
      finish()
    }
  })
}
