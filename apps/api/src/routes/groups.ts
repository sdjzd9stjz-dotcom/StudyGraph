import { forOperation } from '../llm/reasoning.ts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { GROUP_LINK_TARGETS, canLinkGroupTo } from '../../../../packages/contracts/src/index.ts'
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
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(120).optional(),
        /** 组卡片在画布上的位置（组现在是真实节点，可以被拖动） */
        posX: z.number().finite().optional(),
        posY: z.number().finite().optional(),
        /** 收起/展开状态：存库，重进画布时恢复 */
        collapsed: z.boolean().optional(),
      }),
      request.body,
    )

    const group = await prisma.nodeGroup.findUnique({ where: { id }, select: { canvasId: true } })
    if (!group) throw new AppError(404, 'GROUP_NOT_FOUND', '分组不存在')
    await requireCanvasWrite(prisma, group.canvasId, auth.user.id)

    const updated = await prisma.nodeGroup.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.posX !== undefined ? { posX: Math.round(body.posX) } : {}),
        ...(body.posY !== undefined ? { posY: Math.round(body.posY) } : {}),
        ...(body.collapsed !== undefined ? { collapsed: body.collapsed } : {}),
      },
      select: { id: true, title: true, posX: true, posY: true, collapsed: true },
    })
    return updated
  })

  /**
   * 建组前的连线检测（用户 2026-11-24 要求）。
   *
   * 为什么要先查：组里有节点连到组外时，那条边在收起后就成了"看不见的线"，
   * 执行顺序和上下游关系都变得不可理解。建组前把相连节点一并纳入，
   * 组才是封闭的。这里只做**一跳**检测：纳入后再查一次由前端循环调用，
   * 服务端不替用户决定"扩到多大"。
   */
  app.get('/v1/canvases/:canvasId/groups/closure', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const { canvasId } = request.params as { canvasId: string }
    const ids = String((request.query as { ids?: string }).ids ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    await requireCanvasWrite(prisma, canvasId, auth.user.id)

    if (ids.length === 0) return { outside: [] as string[], links: [] as Array<{ from: string; to: string }> }

    const inside = new Set(ids)
    const edges = await prisma.edge.findMany({
      where: { canvasId, OR: [{ fromNodeId: { in: [...inside] } }, { toNodeId: { in: [...inside] } }] },
      select: { fromNodeId: true, toNodeId: true },
    })

    // 只要有一条端点在组外，就是"跨组边"
    const crossing = edges.filter(
      (edge) => inside.has(edge.fromNodeId) !== inside.has(edge.toNodeId),
    )
    const outside = [
      ...new Set(crossing.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]).filter((id) => !inside.has(id))),
    ]
    return { outside, links: crossing.map((edge) => ({ from: edge.fromNodeId, to: edge.toNodeId })) }
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
      const model = await forOperation(deps.llm, 'method', { ...auth.user, canvasId: group.canvasId }, 'group-name')
      const result = await model.complete({
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
        collapsed: true,
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
        collapsed: group.collapsed,
        summary: group.summary,
        memberIds: group.members.map((member) => member.nodeId),
        members: group.members.map((member) => ({ nodeId: member.nodeId, ...member.node })),
        usedBy: group.links.map((link) => link.nodeId),
      })),
    }
  })

  /**
   * 把一个节点并进已有的组（用户 2026-11-24 报「反向连线无法连接」）。
   *
   * 反向拖线（节点输出口 → 组的入点）在画布上表达的是"这个节点归到这组里"，
   * 不是"把它当上游喂给组"——组不执行，没有输入这个概念。
   * 语义明确后两端才好实现，也避免一边建组引用、一边建成员导致同一手势两种后果。
   *
   * 幂等：已在组里就直接返回，不报 409 —— 拖线误触很常见，没必要弹错。
   */
  app.post('/v1/groups/:id/members', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const body = parse(linkBody, request.body)

    const group = await prisma.nodeGroup.findUnique({
      where: { id },
      select: { canvasId: true, members: { select: { nodeId: true } } },
    })
    if (!group) throw new AppError(404, 'GROUP_NOT_FOUND', '分组不存在')
    await requireCanvasWrite(prisma, group.canvasId, auth.user.id)

    if (group.members.some((member) => member.nodeId === body.nodeId)) {
      return reply.status(200).send({ groupId: id, nodeId: body.nodeId, added: false })
    }

    const node = await prisma.node.findFirst({
      where: { id: body.nodeId, canvasId: group.canvasId },
      select: { id: true, title: true, type: true },
    })
    if (!node) throw new AppError(400, 'NODE_NOT_IN_CANVAS', '目标节点不在本画布')

    await prisma.nodeGroupMember.create({ data: { groupId: id, nodeId: body.nodeId } })
    return reply.status(201).send({ groupId: id, nodeId: body.nodeId, added: true, node: { id: node.id, title: node.title, type: node.type } })
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

    const node = await prisma.node.findFirst({
      where: { id: body.nodeId, canvasId: group.canvasId },
      select: { id: true, type: true },
    })
    if (!node) throw new AppError(400, 'NODE_NOT_IN_CANVAS', '目标节点不在本画布')

    /**
     * 只允许接到这几类节点（用户 2026-11-24：「为组添加可以接到的节点：复习、深入理解、导出讲义、先修」）。
     *
     * 判定用 contracts 的同一张表：界面高亮用的就是它，
     * 否则会出现"界面亮着能接、松手被拒"这种最让人困惑的状态。
     * 这四类节点的执行器要么真读 upstreamContext，要么按 groupContext 收窄概念范围 —— 接上去有实际效果。
     */
    if (!canLinkGroupTo(node.type)) {
      throw new AppError(
        400,
        'GROUP_LINK_UNSUPPORTED',
        `组只能接到：${GROUP_LINK_TARGETS.join(' / ')}；当前节点是 ${node.type}`,
        { targetType: node.type, allowed: [...GROUP_LINK_TARGETS] },
      )
    }

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
