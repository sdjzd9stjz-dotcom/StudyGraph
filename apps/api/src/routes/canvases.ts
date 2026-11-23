import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { REQUIRED_CAPABILITY, isTaskType } from '../../../../packages/contracts/src/index.ts'
import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { summarizeArtifact } from '../domain/artifact-text.ts'
import { computeLayout } from '../domain/layout.ts'
import { findCanvasForUser, requireCanvasOwner, requireCanvasWrite } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
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
        // 新建的排最前：用户刚创建的画布一定想立刻看到
        sortOrder: -1,
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
      /**
       * 顺序：用户手工排的在前（sortOrder 升序），没排过的按创建时间倒序。
       * Prisma 里 null 的排序位置各库不同，所以先按 sortOrder 再按 createdAt 兜底，
       * 新建画布的 sortOrder 为 -1，永远排在最前。
       */
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      select: { id: true, title: true, ownerId: true, createdAt: true, updatedAt: true },
    })
    return { canvases }
  })

  /**
   * 重命名 / 改描述（用户 2026-11-23 要求：首页右键可重命名）。
   *
   * 只接受 owner 或 EDITOR：`CANVAS_WRITE` 守卫管作用域，
   * 画布级权限交给 requireCanvasWrite —— 两者不是一回事。
   */
  app.patch('/v1/canvases/:id', { preHandler: guard('CANVAS_WRITE') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
      }),
      request.body,
    )
    await requireCanvasWrite(prisma, id, auth.user.id)

    const canvas = await prisma.canvas.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      },
      select: { id: true, title: true, description: true },
    })
    return canvas
  })

  /**
   * 重排画布（用户 2026-11-23 要求：拖动改变上下顺序）。
   *
   * 传**完整的有序 id 列表**而不是"把 A 移到 B 前面"：
   * 后者在并发下会产生中间态（两个人同时拖，结果互相覆盖成半截顺序）。
   * 整表覆盖是幂等的，重放一次结果相同。
   */
  app.put('/v1/canvases/order', { preHandler: guard('CANVAS_WRITE') }, async (request) => {
    const auth = getAuth(request)
    const body = parse(z.object({ ids: z.array(z.string().min(1)).max(500) }), request.body)

    // 只能排自己的画布：别人的 id 混进来就整批拒绝（不静默跳过）
    const owned = await prisma.canvas.findMany({
      where: { id: { in: body.ids }, ownerId: auth.user.id },
      select: { id: true },
    })
    if (owned.length !== body.ids.length) {
      throw new AppError(403, 'FORBIDDEN', '只能调整自己拥有的画布顺序', {
        requested: body.ids.length,
        owned: owned.length,
      })
    }

    await prisma.$transaction(
      body.ids.map((id, index) => prisma.canvas.update({ where: { id }, data: { sortOrder: index } })),
    )
    return { updated: body.ids.length }
  })

  /**
   * 画布级模型配置（用户 2026-11-23 要求：AI 配置每块画布独立）。
   *
   * 覆盖顺序：这块画布的偏好 → 用户全局偏好 → 内置默认路由。
   * 返回 merge 后的结果，界面才能显示"这块画布实际在用哪个模型"。
   */
  app.get('/v1/canvases/:id/model-prefs', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    await requireCanvasWrite(prisma, id, auth.user.id)

    const [canvasPrefs, globalPrefs] = await Promise.all([
      prisma.canvasModelPref.findMany({
        where: { canvasId: id },
        select: { taskType: true, credentialId: true, modelId: true },
      }),
      prisma.userModelPref.findMany({
        where: { userId: auth.user.id },
        select: { taskType: true, credentialId: true, modelId: true },
      }),
    ])
    return { canvasPrefs, globalPrefs }
  })

  app.put('/v1/canvases/:id/model-prefs/:taskType', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id, taskType } = request.params as { id: string; taskType: string }

    /**
     * 与全局配置同一套规则：任务类型必须已知、模型能力必须满足。
     * 画布配置如果放宽校验，就会出现"全局存不进去的模型，在这块画布里能存"，
     * 然后跑节点时才发现不支持 JSON —— 用户会以为是画布配置的锅。
     */
    if (!isTaskType(taskType)) throw new AppError(400, 'TASK_TYPE_UNKNOWN', `未知任务类型：${taskType}`)

    const body = parse(z.object({ credentialId: z.string().min(1), modelId: z.string().min(1).max(120) }), request.body)
    await requireCanvasWrite(prisma, id, auth.user.id)

    // 凭据必须属于本人且有效：否则等于允许把别人的密钥挂到自己画布上
    const credential = await prisma.userCredential.findFirst({
      where: { id: body.credentialId, userId: auth.user.id, isActive: true },
      include: { provider: true },
    })
    if (!credential) throw new AppError(404, 'PROVIDER_CREDENTIAL_NOT_FOUND', '凭据不存在')

    const model = await prisma.providerModel.findUnique({
      where: { providerId_modelId: { providerId: credential.providerId, modelId: body.modelId } },
    })
    const needed = REQUIRED_CAPABILITY[taskType]
    if (needed && model) {
      const caps = (model.capabilities ?? {}) as Record<string, unknown>
      const declared = Object.keys(caps).length > 0
      if (declared && caps[needed] !== true) {
        throw new AppError(
          400,
          'MODEL_CAPABILITY_MISMATCH',
          `该任务需要 ${needed} 能力，而 ${model.displayName} 未声明支持`,
          { required: needed, model: body.modelId },
        )
      }
    }

    const pref = await prisma.canvasModelPref.upsert({
      where: { canvasId_taskType: { canvasId: id, taskType } },
      create: { canvasId: id, taskType, credentialId: body.credentialId, modelId: body.modelId },
      update: { credentialId: body.credentialId, modelId: body.modelId },
    })
    return reply.status(201).send({ taskType: pref.taskType, credentialId: pref.credentialId, modelId: pref.modelId })
  })

  /**
   * 批量设置画布配置（新建画布对话框用）。
   *
   * 为什么要有它：对话框里可以一次给 8 个功能各选模型，逐条 PUT 会有
   * 两个问题 —— 8 次往返，以及中途失败时画布处于"配了一半"的状态。
   * 这里整批校验、整批写入，要么全成要么全不成。
   */
  app.put('/v1/canvases/:id/model-prefs', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const body = parse(
      z.object({
        prefs: z
          .array(z.object({ taskType: z.string().min(1), credentialId: z.string().min(1), modelId: z.string().min(1).max(120) }))
          .max(20),
      }),
      request.body,
    )
    await requireCanvasWrite(prisma, id, auth.user.id)

    const credentialIds = [...new Set(body.prefs.map((pref) => pref.credentialId))]
    const credentials = await prisma.userCredential.findMany({
      where: { id: { in: credentialIds }, userId: auth.user.id, isActive: true },
      include: { provider: true },
    })
    const byId = new Map(credentials.map((credential) => [credential.id, credential]))

    for (const pref of body.prefs) {
      if (!isTaskType(pref.taskType)) {
        throw new AppError(400, 'TASK_TYPE_UNKNOWN', `未知任务类型：${pref.taskType}`)
      }
      const credential = byId.get(pref.credentialId)
      if (!credential) throw new AppError(404, 'PROVIDER_CREDENTIAL_NOT_FOUND', `凭据不存在：${pref.credentialId}`)

      const model = await prisma.providerModel.findUnique({
        where: { providerId_modelId: { providerId: credential.providerId, modelId: pref.modelId } },
      })
      const needed = REQUIRED_CAPABILITY[pref.taskType]
      if (needed && model) {
        const caps = (model.capabilities ?? {}) as Record<string, unknown>
        if (Object.keys(caps).length > 0 && caps[needed] !== true) {
          throw new AppError(
            400,
            'MODEL_CAPABILITY_MISMATCH',
            `${pref.taskType} 需要 ${needed} 能力，而 ${model.displayName} 未声明支持`,
            { taskType: pref.taskType, model: pref.modelId },
          )
        }
      }
    }

    await prisma.$transaction(
      body.prefs.map((pref) =>
        prisma.canvasModelPref.upsert({
          where: { canvasId_taskType: { canvasId: id, taskType: pref.taskType } },
          create: { canvasId: id, taskType: pref.taskType, credentialId: pref.credentialId, modelId: pref.modelId },
          update: { credentialId: pref.credentialId, modelId: pref.modelId },
        }),
      ),
    )
    return reply.status(201).send({ saved: body.prefs.length })
  })

  app.delete('/v1/canvases/:id/model-prefs/:taskType', { preHandler: guard('CANVAS_WRITE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id, taskType } = request.params as { id: string; taskType: string }
    await requireCanvasWrite(prisma, id, auth.user.id)
    // 删掉 = 回落到全局偏好，不是"不配置"
    await prisma.canvasModelPref.deleteMany({ where: { canvasId: id, taskType } })
    return reply.status(204).send()
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
  /**
   * 一键整理：按依赖方向重排节点位置（用户 2026-11-21 要求）。
   *
   * 只改坐标，不改结构：不建节点、不连线、不执行、不动产物。
   * 所以它便宜到可以随手点，也**不会**让任何节点失效。
   */
  app.post('/v1/canvases/:id/layout', { preHandler: guard('CANVAS_WRITE') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    await findCanvasForUser(prisma, id, auth.user.id)

    const [nodes, edges] = await Promise.all([
      prisma.node.findMany({
        where: { canvasId: id },
        select: { id: true, posX: true, posY: true },
      }),
      prisma.edge.findMany({ where: { canvasId: id }, select: { fromNodeId: true, toNodeId: true } }),
    ])

    const positions = computeLayout(
      nodes.map((node) => ({ id: node.id, x: node.posX, y: node.posY })),
      edges.map((edge) => ({ from: edge.fromNodeId, to: edge.toNodeId })),
    )

    // 一次事务批量落库：中途失败不会留下"排了一半"的画布
    await prisma.$transaction(
      [...positions.entries()].map(([nodeId, pos]) =>
        prisma.node.update({ where: { id: nodeId }, data: { posX: pos.x, posY: pos.y } }),
      ),
    )

    return { moved: positions.size, positions: Object.fromEntries(positions) }
  })

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
