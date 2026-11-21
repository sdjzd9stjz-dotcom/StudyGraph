import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { requireCanvasWrite } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

/**
 * F2 · Skill 指令包管理（M4.5）。
 *
 * 隔离规则：`BUILTIN` 所有人可见只读；`USER` 只有 owner 自己看得见、改得动。
 * 每次改动正文或开关都会 `version + 1` —— 这是缓存能正确失效的前提。
 */

const createBody = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,60}$/, 'slug 只能是小写字母、数字与短横线'),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(300),
  instructions: z.string().min(1).max(8000),
  assets: z.array(z.object({ name: z.string().max(80), kind: z.string().max(30), content: z.string().max(8000) })).max(20).optional(),
})

const patchBody = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().min(1).max(300).optional(),
  instructions: z.string().min(1).max(8000).optional(),
  enabled: z.boolean().optional(),
})

const bindBody = z.object({ skillIds: z.array(z.string().min(1)).max(20) })

export interface SkillRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
}

export function registerSkillRoutes(app: FastifyInstance, deps: SkillRouteDeps): void {
  const { prisma, guard } = deps

  /** 内置 + 自己的；不含他人的 USER skill（规格约束 3） */
  app.get('/v1/skills', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const skills = await prisma.skill.findMany({
      where: { OR: [{ scope: 'BUILTIN' }, { scope: 'USER', ownerId: auth.user.id }] },
      orderBy: [{ scope: 'asc' }, { slug: 'asc' }],
      select: { id: true, slug: true, name: true, description: true, instructions: true, scope: true, enabled: true, version: true, assets: true },
    })
    return { skills }
  })

  app.post('/v1/skills', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const body = parse(createBody, request.body)

    // 与内置项撞 slug 会让"到底注入的是哪个"无法回答
    const exists = await prisma.skill.findUnique({ where: { slug: body.slug }, select: { id: true } })
    if (exists) throw new AppError(409, 'SKILL_SLUG_TAKEN', `slug 已被占用：${body.slug}`)

    const skill = await prisma.skill.create({
      data: {
        slug: body.slug,
        name: body.name,
        description: body.description,
        instructions: body.instructions,
        assets: body.assets ?? undefined,
        scope: 'USER',
        ownerId: auth.user.id,
        version: 1,
      },
      select: { id: true, slug: true, name: true, version: true, scope: true, enabled: true },
    })
    return reply.status(201).send(skill)
  })

  app.patch('/v1/skills/:id', { preHandler: guard('CANVAS_WRITE') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const body = parse(patchBody, request.body)

    const skill = await prisma.skill.findFirst({ where: { id, scope: 'USER', ownerId: auth.user.id } })
    if (!skill) throw new AppError(404, 'SKILL_NOT_FOUND', '技能不存在或不可修改（内置技能只读）')

    const touchedContent = body.instructions !== undefined || body.enabled !== undefined
    const updated = await prisma.skill.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        // 正文或开关变了才 +1：只改名字不该让全画布缓存失效
        ...(touchedContent ? { version: { increment: 1 } } : {}),
      },
      select: { id: true, slug: true, name: true, version: true, enabled: true },
    })
    return updated
  })

  app.delete('/v1/skills/:id', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const skill = await prisma.skill.findFirst({ where: { id, scope: 'USER', ownerId: auth.user.id }, select: { id: true } })
    if (!skill) throw new AppError(404, 'SKILL_NOT_FOUND', '技能不存在或不可删除（内置技能只读）')
    await prisma.skill.delete({ where: { id } })
    return reply.status(204).send()
  })

  /** 读节点已绑定的 skill */
  app.get('/v1/nodes/:id/skills', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const node = await prisma.node.findUnique({ where: { id }, select: { canvasId: true } })
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', '节点不存在')
    await requireCanvasWrite(prisma, node.canvasId, auth.user.id)

    const rows = await prisma.nodeSkill.findMany({
      where: { nodeId: id },
      select: { skill: { select: { id: true, slug: true, name: true, version: true, enabled: true } } },
    })
    return { skills: rows.map((row) => row.skill) }
  })

  /**
   * 覆盖式绑定。`skillIds: []` 就是全部解绑。
   *
   * 绑定后节点的指纹会变（skill 的 slug+version 进指纹），
   * 下次执行必然重跑 —— 这正是规格要的效果，不是 bug。
   */
  app.put('/v1/nodes/:id/skills', { preHandler: guard('CANVAS_WRITE') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const body = parse(bindBody, request.body)

    const node = await prisma.node.findUnique({ where: { id }, select: { canvasId: true } })
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', '节点不存在')
    await requireCanvasWrite(prisma, node.canvasId, auth.user.id)

    // 只能绑自己看得见的 skill
    const allowed = await prisma.skill.findMany({
      where: { id: { in: body.skillIds }, OR: [{ scope: 'BUILTIN' }, { scope: 'USER', ownerId: auth.user.id }] },
      select: { id: true },
    })
    if (allowed.length !== new Set(body.skillIds).size) {
      throw new AppError(400, 'SKILL_NOT_ACCESSIBLE', '包含不存在或无权使用的技能')
    }

    await prisma.$transaction([
      prisma.nodeSkill.deleteMany({ where: { nodeId: id } }),
      prisma.nodeSkill.createMany({ data: body.skillIds.map((skillId) => ({ nodeId: id, skillId })) }),
    ])

    const rows = await prisma.nodeSkill.findMany({
      where: { nodeId: id },
      select: { skill: { select: { id: true, slug: true, name: true, version: true } } },
    })
    return { nodeId: id, skills: rows.map((row) => row.skill) }
  })
}
