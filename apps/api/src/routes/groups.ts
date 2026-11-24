import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { summarizeArtifact } from '../domain/artifact-text.ts'
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
  readonly llm: import('../llm/types.ts').LLMGateway
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

  /**
   * AI 给打包组起名（用户 2026-11-23 要求：可以默认由 AI 总结命名）。
   *
   * 用什么命名：成员的标题 + 各自产物的摘要。不能用整份产物 ——
   * 起一个 6 字的名字，把 2 万字塞进上下文既慢又贵，还会让模型跑偏。
   * 失败不影响使用：返回 ok:false，界面保留原来的名字让用户自己改。
   */
  /**
   * 重命名分组（用户 2026-11-24 要求：分组右键可重命名）。
   *
   * 只改 title：成员、位置、颜色都由其它接口管，混在一起会让一次改名
   * 意外清掉别的东西。
   */
  app.patch('/v1/groups/:id', { preHandler: guard('CANVAS_WRITE') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const body = parse(z.object({ title: z.string().trim().min(1).max(120) }), request.body)

    const group = await prisma.nodeGroup.findUnique({ where: { id }, select: { canvasId: true } })
    if (!group) throw new AppError(404, 'GROUP_NOT_FOUND', '分组不存在')
    await requireCanvasWrite(prisma, group.canvasId, auth.user.id)

    const updated = await prisma.nodeGroup.update({
      where: { id },
      data: { title: body.title },
      select: { id: true, title: true },
    })
    return updated
  })

  app.post('/v1/groups/:id/auto-name', { preHandler: guard('CANVAS_WRITE') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const group = await prisma.nodeGroup.findUnique({
      where: { id },
      select: {
        id: true,
        canvasId: true,
        members: {
          select: {
            node: {
              select: {
                id: true,
                type: true,
                title: true,
                artifacts: { orderBy: { createdAt: 'desc' }, take: 1, select: { kind: true, structured: true } },
              },
            },
          },
        },
      },
    })
    if (!group) throw new AppError(404, 'NODE_NOT_FOUND', '分组不存在', { groupId: id })
    await requireCanvasWrite(prisma, group.canvasId, auth.user.id)

    const material = group.members
      .map((member) => {
        const node = member.node
        const artifact = node.artifacts[0]
        const summary = artifact ? summarizeArtifact(artifact.kind, artifact.structured).slice(0, 300) : ''
        return '-' + (node.title ?? node.type) + '（' + node.type + '）' + (summary ? '：' + summary.split('\n').slice(0, 3).join(' ') : '')
      })
      .join('\n')

    try {
      const result = await deps.llm.complete({
        taskType: 'method',
        messages: [
          {
            role: 'system',
            content:
              '你给一组学习节点起名字。输出一个 JSON：{"title":"..."}。\n' +
              '要求：6–12 个汉字，概括这几个节点合起来在做什么；不要引号、不要书名号、不要标点结尾。',
          },
          { role: 'user', content: material },
        ],
        jsonSchema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
          additionalProperties: false,
        },
        user: { ...auth.user, canvasId: group.canvasId },
      })

      const raw = (result.data as { title?: unknown } | undefined)?.title
      const title = typeof raw === 'string' ? raw.trim().replace(/^["「『]|["」』]$/g, '').slice(0, 40) : ''
      if (title.length === 0) return { ok: false, title: null, reason: '模型没有给出名字' }

      await prisma.nodeGroup.update({ where: { id }, data: { title } })
      return { ok: true, title }
    } catch (error) {
      // 没配密钥、模型报错：都不该让"打包"这一步失败，让用户自己填名字即可
      return { ok: false, title: null, reason: error instanceof Error ? error.message : String(error) }
    }
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
