import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { requireCanvasWrite } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

/**
 * 节点分组：把一部分节点打包成一个上下文单元（用户 2026-11-21 要求）。
 *
 * 用法：
 *   1. 选中几个节点 → 打包 → 得到一个可折叠的组
 *   2. 另一个节点可以把这个组当上下文引用（`POST /v1/groups/:id/link`）
 *      → 执行时该组的成员产物会作为上游一起传进去
 *
 * 与「新建一个节点类型」的区别：组不执行、不产出 Artifact，
 * 它只是「这几个节点的产物一起看」。所以它不该占用 17 个节点类型之一。
 */

const createBody = z.object({
  title: z.string().trim().min(1).max(80),
  nodeIds: z.array(z.string().min(1)).min(1).max(50),
  posX: z.number().default(0),
  posY: z.number().default(0),
})

const linkBody = z.object({ nodeId: z.string().min(1) })

export interface GroupRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
}

export function registerGroupRoutes(app: FastifyInstance, deps: GroupRouteDeps): void {
  const { prisma, guard } = deps

  /** 打包：把一组节点归进一个组。节点必须都属于同一张画布。 */
  app.post('/v1/canvases/:canvasId/groups', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { canvasId } = request.params as { canvasId: string }
    const body = parse(createBody, request.body)
    await requireCanvasWrite(prisma, canvasId, auth.user.id)

    const nodes = await prisma.node.findMany({
      where: { id: { in: body.nodeIds }, canvasId },
      select: { id: true, type: true, title: true, status: true, artifacts: { orderBy: { createdAt: 'desc' }, take: 1, select: { kind: true } } },
    })
    if (nodes.length !== new Set(body.nodeIds).size) {
      throw new AppError(400, 'NODE_NOT_IN_CANVAS', '包含不存在或不属于本画布的节点')
    }

    // 摘要：打包的意义就是"这一摊东西合起来是什么"
    const summary = {
      nodeCount: nodes.length,
      types: [...new Set(nodes.map((node) => node.type))],
      ready: nodes.filter((node) => node.status === 'READY').length,
      artifactKinds: [...new Set(nodes.flatMap((node) => node.artifacts.map((a) => a.kind)))],
    }

    const group = await prisma.nodeGroup.create({
      data: {
        canvasId,
        title: body.title,
        posX: body.posX,
        posY: body.posY,
        ownerId: auth.user.id,
        summary: summary as unknown as object,
        members: { create: body.nodeIds.map((nodeId) => ({ nodeId })) },
      },
      select: { id: true, title: true, posX: true, posY: true, color: true, summary: true },
    })

    return reply.status(201).send(group)
  })

  /** 列出画布上的组，带成员与"被谁引用"。 */
  app.get('/v1/canvases/:canvasId/groups', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const { canvasId } = request.params as { canvasId: string }
    await requireCanvasWrite(prisma, canvasId, auth.user.id)

    const groups = await prisma.nodeGroup.findMany({
      where: { canvasId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        title: true,
        posX: true,
        posY: true,
        color: true,
        summary: true,
        members: { select: { nodeId: true, node: { select: { type: true, title: true, status: true } } } },
        links: { select: { nodeId: true } },
      },
    })

    return {
      groups: groups.map((group) => ({
        id: group.id,
        title: group.title,
        posX: group.posX,
        posY: group.posY,
        color: group.color,
        summary: group.summary,
        memberIds: group.members.map((member) => member.nodeId),
        members: group.members.map((member) => ({ nodeId: member.nodeId, ...member.node })),
        usedBy: group.links.map((link) => link.nodeId),
      })),
    }
  })

  /** 把一个组当作另一个节点的上下文。 */
  app.post('/v1/groups/:id/link', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const body = parse(linkBody, request.body)

    const group = await prisma.nodeGroup.findUnique({ where: { id }, select: { canvasId: true, members: { select: { nodeId: true } } } })
    if (!group) throw new AppError(404, 'GROUP_NOT_FOUND', '分组不存在')
    await requireCanvasWrite(prisma, group.canvasId, auth.user.id)

    // 不能把组引用到自己组内的节点上：那会形成自引用，执行时拿不到新东西
    if (group.members.some((member) => member.nodeId === body.nodeId)) {
      throw new AppError(400, 'GROUP_SELF_REFERENCE', '不能把一个组接回它自己的成员节点')
    }

    const node = await prisma.node.findFirst({ where: { id: body.nodeId, canvasId: group.canvasId }, select: { id: true } })
    if (!node) throw new AppError(400, 'NODE_NOT_IN_CANVAS', '目标节点不在本画布')

    const link = await prisma.nodeGroupLink.upsert({
      where: { groupId_nodeId: { groupId: id, nodeId: body.nodeId } },
      create: { groupId: id, nodeId: body.nodeId },
      update: {},
      select: { id: true, groupId: true, nodeId: true },
    })
    return reply.status(201).send(link)
  })

  app.delete('/v1/groups/:id/link/:nodeId', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id, nodeId } = request.params as { id: string; nodeId: string }
    const group = await prisma.nodeGroup.findUnique({ where: { id }, select: { canvasId: true } })
    if (!group) throw new AppError(404, 'GROUP_NOT_FOUND', '分组不存在')
    await requireCanvasWrite(prisma, group.canvasId, auth.user.id)

    await prisma.nodeGroupLink.deleteMany({ where: { groupId: id, nodeId } })
    return reply.status(204).send()
  })

  /** 解组：删掉组本身（成员节点不受影响）。 */
  app.delete('/v1/groups/:id', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const group = await prisma.nodeGroup.findUnique({ where: { id }, select: { canvasId: true } })
    if (!group) throw new AppError(404, 'GROUP_NOT_FOUND', '分组不存在')
    await requireCanvasWrite(prisma, group.canvasId, auth.user.id)

    await prisma.nodeGroup.delete({ where: { id } })
    return reply.status(204).send()
  })
}
