import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { summarizeArtifact } from '../domain/artifact-text.ts'
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

    /**
     * 每个节点最近一次运行的产物 → 一段可读的文字。
     *
     * 画布要像"学习地图"而不是一堆只有标题的方块，就必须把产物内容显示出来。
     * 摘要由 `summarizeArtifact` 确定性生成：模型产了什么就显示什么，不再调一次模型。
     */
    const artifacts = await prisma.artifact.findMany({
      where: { node: { canvasId: id } },
      orderBy: { createdAt: 'desc' },
      select: { nodeId: true, kind: true, structured: true },
    })
    const latest = new Map<string, { kind: string; structured: unknown }>()
    for (const artifact of artifacts) {
      if (latest.has(artifact.nodeId)) continue
      latest.set(artifact.nodeId, { kind: artifact.kind, structured: artifact.structured })
    }

    return {
      id: canvas.id,
      title: canvas.title,
      ownerId: canvas.ownerId,
      createdAt: canvas.createdAt,
      nodes: canvas.nodes.map((node) => {
        const artifact = latest.get(node.id)
        return {
          ...node,
          // null = 还没跑过，界面据此显示"未运行"而不是一段空文本
          outputText: artifact ? summarizeArtifact(artifact.kind, artifact.structured) : null,
          outputKind: artifact?.kind ?? null,
        }
      }),
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

  /**
   * `POST /v1/canvases/:id/clone` —— 克隆工作流（M4）。
   *
   * 只复制**结构**：节点（参数保留、状态重置为 DRAFT）与连线。
   * 不复制产物、概念卡、课件：那些是原作者的数据，克隆者拿到的应该是
   * "一套可以自己重跑一遍的流程"，而不是别人的学习成果。
   *
   * 署名：写 `forkedFromId` 与 `originAuthorName`，原作者 `forkCount` +1。
   * 这是分享工作流的基本礼节，也是规格里「分享时只授予 canvas:read + clone」的落点。
   */
  app.post('/v1/canvases/:id/clone', { preHandler: guard('CANVAS_READ') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const body = parse(z.object({ title: z.string().trim().min(1).max(200).optional() }), request.body ?? {})

    const source = await findCanvasForUser(prisma, id, auth.user.id)

    const [nodes, edges, author] = await Promise.all([
      prisma.node.findMany({
        where: { canvasId: id },
        select: { id: true, type: true, title: true, params: true, posX: true, posY: true },
      }),
      prisma.edge.findMany({
        where: { canvasId: id },
        select: { fromNodeId: true, toNodeId: true, kind: true, fromPort: true, toPort: true },
      }),
      prisma.user.findUnique({ where: { id: source.canvas.ownerId }, select: { displayName: true } }),
    ])

    const cloned = await prisma.$transaction(async (tx) => {
      const canvas = await tx.canvas.create({
        data: {
          ownerId: auth.user.id,
          title: body.title ?? `${source.canvas.title} 副本`,
          visibility: 'PRIVATE',
          forkedFromId: id,
          originAuthorName: author?.displayName ?? null,
        },
      })

      // 节点 id 必须重发：复合外键 (canvasId, nodeId) 保证了跨画布连线写不进去
      const idMap = new Map<string, string>()
      for (const node of nodes) {
        const created = await tx.node.create({
          data: {
            canvasId: canvas.id,
            type: node.type,
            title: node.title,
            params: node.params as object,
            // 克隆出来的节点一律 DRAFT：没有产物、没有指纹，必须自己再执行一次
            status: 'DRAFT',
            posX: node.posX,
            posY: node.posY,
          },
          select: { id: true },
        })
        idMap.set(node.id, created.id)
      }

      for (const edge of edges) {
        const from = idMap.get(edge.fromNodeId)
        const to = idMap.get(edge.toNodeId)
        if (!from || !to) continue
        await tx.edge.create({
          data: {
            canvasId: canvas.id,
            fromNodeId: from,
            toNodeId: to,
            kind: edge.kind,
            fromPort: edge.fromPort,
            toPort: edge.toPort,
          },
        })
      }

      await tx.canvas.update({ where: { id }, data: { forkCount: { increment: 1 } } })
      return canvas
    })

    return reply.status(201).send({
      id: cloned.id,
      title: cloned.title,
      forkedFromId: id,
      originAuthorName: cloned.originAuthorName,
      nodes: nodes.length,
      edges: edges.length,
    })
  })
}
