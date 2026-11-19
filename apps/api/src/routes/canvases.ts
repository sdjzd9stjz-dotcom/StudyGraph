import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { findCanvasForUser, requireCanvasOwner } from '../lib/access.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'
import type { ObjectStore } from '../storage/object-store.ts'

const createBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
})

export interface CanvasRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
  readonly objectStore: ObjectStore
}

export function registerCanvasRoutes(app: FastifyInstance, deps: CanvasRouteDeps): void {
  const { prisma, guard, objectStore } = deps

  app.post('/v1/canvases', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const body = parse(createBody, request.body)

    const canvas = await prisma.canvas.create({
      data: {
        ownerId: auth.user.id, // ownerId 只从 token 取，不接受 body（否则能替别人建画布）
        title: body.title,
        description: body.description ?? null,
      },
      select: { id: true, title: true, ownerId: true, createdAt: true },
    })

    return reply.status(201).send(canvas)
  })

  app.get('/v1/canvases', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const canvases = await prisma.canvas.findMany({
      where: {
        OR: [{ ownerId: auth.user.id }, { members: { some: { userId: auth.user.id } } }],
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, ownerId: true, createdAt: true, updatedAt: true },
    })
    return { canvases }
  })

  app.get('/v1/canvases/:id', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }

    // 无权访问 → 404（不泄露画布是否存在）
    await findCanvasForUser(prisma, id, auth.user.id)

    const canvas = await prisma.canvas.findUniqueOrThrow({
      where: { id },
      include: {
        nodes: { orderBy: { createdAt: 'asc' } },
        edges: { orderBy: { createdAt: 'asc' } },
      },
    })

    return {
      id: canvas.id,
      title: canvas.title,
      ownerId: canvas.ownerId,
      createdAt: canvas.createdAt,
      nodes: canvas.nodes,
      edges: canvas.edges,
    }
  })

  app.delete('/v1/canvases/:id', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }

    await requireCanvasOwner(prisma, id, auth.user.id)

    // 1. 先算对象存储 key 清单（删库之后就查不到了）
    const [sources, artifacts] = await Promise.all([
      prisma.source.findMany({ where: { node: { canvasId: id } }, select: { s3Key: true } }),
      prisma.artifact.findMany({ where: { node: { canvasId: id } }, select: { s3Key: true } }),
    ])
    const objectKeys = [...sources, ...artifacts]
      .map((row) => row.s3Key)
      .filter((key): key is string => Boolean(key))

    // 2. 删库（Node / Run / Artifact / Edge 等按 onDelete: Cascade 级联）
    await prisma.canvas.delete({ where: { id } })

    // 3. 删桶：失败只记 orphanObjects，不回滚（对象存储不是事务资源）
    const { deleted, orphanKeys } = await objectStore.deleteMany(objectKeys)
    request.log.info(
      {
        event: 'canvas.deleted',
        canvasId: id,
        objectStore: objectStore.kind,
        objectKeys: objectKeys.length,
        deletedObjects: deleted,
        orphanObjects: orphanKeys.length,
        orphanKeys,
      },
      '画布已删除',
    )

    return reply.status(204).send()
  })
}
