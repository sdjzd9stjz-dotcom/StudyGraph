import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

/**
 * 能力要求表来自 contracts：全局配置与画布配置共用同一份，
 * 否则会出现"全局拒绝、画布接受"的不一致。
 */
import { listedReasoningLevels } from '../../../../packages/contracts/src/reasoning.ts'
import { REQUIRED_CAPABILITY } from '../../../../packages/contracts/src/index.ts'
import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { decryptSecret, encryptSecret, last4 } from '../llm/byok.ts'
import { AppError } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

/**
 * 多供应商与 BYOK 管理（规格「多供应商与 BYOK」，对标 Cherry Studio）。
 *
 * 三条红线（规格「凭据安全」，每条都对应一次真实事故的可能性）：
 *   1. 密钥明文只进内存，响应里**永远**只有 last4
 *   2. 主密钥缺失时拒绝加密 —— 不退化成明文存库
 *   3. 每条查询都带 userId；管理员也读不到别人的明文
 */

const protocolSchema = z.enum(['OPENAI', 'ANTHROPIC', 'GEMINI'])

const createCredentialBody = z.object({
  apiKey: z.string().min(4, '密钥太短').max(400, '密钥太长'),
  label: z.string().min(1).max(40).default('default'),
  /** 自定义 OpenAI 兼容端点用；为空则用供应商的 baseUrl */
  baseUrlOverride: z.string().url('必须是合法 URL').optional(),
})

const createProviderBody = z.object({
  name: z.string().min(1, '请填名称').max(60),
  protocol: protocolSchema.default('OPENAI'),
  baseUrl: z.string().url('必须是合法 URL，例如 https://your-gateway.example.com/v1'),
  docsUrl: z.string().url().optional(),
  keyRequired: z.boolean().default(true),
  /** 可顺手登记模型名，之后在任务偏好里选 */
  models: z.array(z.object({ modelId: z.string().min(1).max(120), displayName: z.string().min(1).max(120).optional() })).max(20).default([]),
})

const prefBody = z.object({
  credentialId: z.string().min(1),
  modelId: z.string().min(1).max(120),
})

export interface ProviderRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
  readonly masterKey?: string | undefined
}

export function registerProviderRoutes(app: FastifyInstance, deps: ProviderRouteDeps): void {
  const { prisma, guard } = deps

  const requireMasterKey = (): string => {
    if (!deps.masterKey) {
      throw new AppError(409, 'BYOK_MASTER_KEY_MISSING', '主密钥未配置，拒绝保存密钥（不会退化成明文存储）')
    }
    return deps.masterKey
  }

  /** 预置目录 + 我的自定义端点，附带我在每一项下已保存的凭据（只含 last4）。 */
  app.get('/v1/providers', { preHandler: guard('RUN_EXECUTE') }, async (request) => {
    const auth = getAuth(request)

    const [providers, credentials, prefs, recentUsage] = await Promise.all([
      prisma.provider.findMany({
        where: { OR: [{ isCustom: false }, { ownerId: auth.user.id }] },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        /**
         * 停用的模型也要返回，只靠 `enabled` 标记区分。
         *
         * 之前这里 `where: { enabled: true }`：一旦某次操作把模型停用，它就从列表里
         * 彻底消失 —— 界面上既看不到、也没法重新启用，任务下拉跟着变空，
         * 用户只会看到"拉到 2 个模型"却一个都选不了（实际遇到）。
         * 可见性优先：能不能选由 enabled 决定，但你必须看得见它。
         */
        include: { models: { orderBy: [{ enabled: 'desc' }, { displayName: 'asc' }] } },
      }),
      prisma.userCredential.findMany({
        where: { userId: auth.user.id, isActive: true },
        orderBy: { createdAt: 'desc' },
        select: { id: true, providerId: true, label: true, last4: true, status: true, baseUrlOverride: true, createdAt: true },
      }),
      prisma.userModelPref.findMany({ where: { userId: auth.user.id } }),
      prisma.usageRecord.findMany({ where: { userId: auth.user.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 12,
        select: { id: true, model: true, tokensIn: true, cachedTokens: true, cacheUsageComplete: true, createdAt: true } }),
    ])

    return {
      recentUsage,
      encryptionReady: Boolean(deps.masterKey),
      providers: providers.map((provider) => ({
        id: provider.id,
        slug: provider.slug,
        name: provider.name,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        docsUrl: provider.docsUrl,
        keyRequired: provider.keyRequired,
        isCustom: provider.isCustom,
        models: provider.models.map((m) => ({
          id: m.id,
          modelId: m.modelId,
          displayName: m.displayName,
          contextWindow: m.contextWindow,
          capabilities: m.capabilities,
          // 必须带上：界面靠它把停用的模型显示成灰色并给出「启用」按钮。
          // 少了它，前面「停用模型也要可见」就只剩可见、没有状态 —— 停用的模型会被当成可选。
          enabled: m.enabled,
        })),
        credentials: credentials
          .filter((c) => c.providerId === provider.id)
          .map((c) => ({
            id: c.id,
            label: c.label,
            last4: c.last4,
            status: c.status,
            baseUrlOverride: c.baseUrlOverride,
            createdAt: c.createdAt,
          })),
      })),
      preferences: prefs.map((p) => ({ taskType: p.taskType, credentialId: p.credentialId, modelId: p.modelId })),
      requiredCapabilities: REQUIRED_CAPABILITY,
    }
  })

  /** 新建自定义供应商（校园网关、企业代理、本地 Ollama、中转站）。 */
  app.post('/v1/providers', { preHandler: guard('RUN_EXECUTE') }, async (request, reply) => {
    const auth = getAuth(request)
    const body = parse(createProviderBody, request.body)

    const provider = await prisma.provider.create({
      data: {
        // custom- 前缀保证不与预置 slug 冲突
        slug: `custom-${crypto.randomUUID().slice(0, 8)}`,
        name: body.name,
        protocol: body.protocol,
        baseUrl: body.baseUrl,
        docsUrl: body.docsUrl ?? null,
        keyRequired: body.keyRequired,
        isCustom: true,
        ownerId: auth.user.id,
        sortOrder: 1000,
        models: {
          create: body.models.map((m) => ({
            modelId: m.modelId,
            displayName: m.displayName ?? m.modelId,
            contextWindow: 0,
            capabilities: {},
          })),
        },
      },
      include: { models: true },
    })

    return reply.status(201).send({
      id: provider.id,
      slug: provider.slug,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      isCustom: true,
      models: provider.models.map((m) => ({ id: m.id, modelId: m.modelId, displayName: m.displayName })),
    })
  })

  /** 删除自定义供应商（连带它的凭据与偏好，由外键级联）。预置项不能删。 */
  app.delete('/v1/providers/:id', { preHandler: guard('RUN_EXECUTE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }

    const provider = await prisma.provider.findFirst({ where: { id, ownerId: auth.user.id, isCustom: true } })
    if (!provider) throw new AppError(404, 'PROVIDER_NOT_FOUND', '自定义供应商不存在或不可删除')

    await prisma.provider.delete({ where: { id } })
    return reply.status(204).send()
  })

  /**
   * 拉取模型列表：用已保存的密钥去问供应商「你有哪些模型」。
   *
   * 为什么要这个：预置目录里的模型名会过时（厂商加新模型、下架旧模型），
   * 学生也不该去翻文档抄模型名。点一下按钮，用他自己的密钥拉到真实列表。
   *
   * 协议差异只在 URL 与鉴权头上，不复制多份适配器：
   *   OPENAI    → GET {baseUrl}/models            Authorization: Bearer
   *   ANTHROPIC → GET {baseUrl}/v1/models         x-api-key + anthropic-version
   *   GEMINI    → GET {baseUrl}/v1beta/models?key=  （返回结构也不同，单独映射）
   */
  app.post('/v1/providers/:id/models/refresh', { preHandler: guard('RUN_EXECUTE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const masterKey = requireMasterKey()

    const provider = await prisma.provider.findFirst({
      where: { id, OR: [{ isCustom: false }, { ownerId: auth.user.id }] },
    })
    if (!provider) throw new AppError(404, 'PROVIDER_NOT_FOUND', '供应商不存在')

    // 用最新保存的那条凭据（与 resolveTarget 的取法一致）
    const credential = await prisma.userCredential.findFirst({
      where: { userId: auth.user.id, providerId: id, isActive: true },
      orderBy: { createdAt: 'desc' },
    })
    if (!credential) throw new AppError(400, 'PROVIDER_CREDENTIAL_MISSING', '请先保存这个供应商的密钥，再拉取模型列表')

    let apiKey: string
    try {
      apiKey = decryptSecret(credential.ciphertext, masterKey)
    } catch (error) {
      throw new AppError(409, 'BYOK_MASTER_KEY_MISSING', error instanceof Error ? error.message : String(error))
    }

    const baseUrl = (credential.baseUrlOverride ?? provider.baseUrl).replace(/\/$/, '')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    let url: string

    if (provider.protocol === 'ANTHROPIC') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
      url = `${baseUrl.replace(/\/v1$/, '')}/v1/models`
    } else if (provider.protocol === 'GEMINI') {
      url = `${baseUrl}/v1beta/models?key=${encodeURIComponent(apiKey)}`
    } else {
      headers.authorization = `Bearer ${apiKey}`
      url = `${baseUrl}/models`
    }

    let payload: unknown
    try {
      const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(20000) })
      const text = await response.text()
      if (!response.ok) {
        throw new AppError(
          502,
          'LLM_PROVIDER_ERROR',
          `拉取模型列表失败（${response.status}）：${text.slice(0, 200)}`,
          { provider: provider.slug, url: url.replace(apiKey, '***') },
        )
      }
      payload = JSON.parse(text)
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(502, 'LLM_PROVIDER_ERROR', `连不上 ${provider.name}：${error instanceof Error ? error.message : String(error)}`)
    }

    // 三家返回结构不同：OpenAI 是 { data: [{ id }] }，Anthropic 同形，Gemini 是 { models: [{ name: 'models/x' }] }
    const raw = payload as { data?: Array<{ id?: unknown } & Parameters<typeof listedReasoningLevels>[1]>; models?: Array<{ name?: unknown; displayName?: unknown }> }
    const discovered: Array<{ modelId: string; displayName: string; levels?: string[] }> = []

    if (Array.isArray(raw.data)) {
      for (const item of raw.data) {
        if (typeof item?.id !== 'string' || !item.id.trim()) continue
        const levels = listedReasoningLevels(item.id.trim(), item)
        discovered.push({ modelId: item.id.trim(), displayName: item.id.trim(), levels })
      }
    } else if (Array.isArray(raw.models)) {
      for (const item of raw.models) {
        if (typeof item?.name !== 'string') continue
        // Gemini 的 name 形如 "models/gemini-1.5-pro"，去掉前缀
        const modelId = item.name.replace(/^models\//, '')
        const displayName = typeof item.displayName === 'string' && item.displayName ? item.displayName : modelId
        discovered.push({ modelId, displayName })
      }
    }

    if (discovered.length === 0) {
      throw new AppError(502, 'PROVIDER_RESPONSE_INVALID', '供应商返回的模型列表为空或结构无法识别')
    }

    // 逐个 upsert：已存在的只更新展示名，不动用户手动关掉的 enabled
    let added = 0
    for (const item of discovered) {
      const existing = await prisma.providerModel.findUnique({
        where: { providerId_modelId: { providerId: id, modelId: item.modelId } },
        select: { id: true, capabilities: true },
      })
      if (existing) {
        const capabilities = { ...(existing.capabilities as Record<string, never> | null), reasoningLevels: item.levels }
        await prisma.providerModel.update({ where: { id: existing.id }, data: { displayName: item.displayName, capabilities } })
      } else {
        await prisma.providerModel.create({
          data: { providerId: id, modelId: item.modelId, displayName: item.displayName, contextWindow: 0, capabilities: item.levels ? { reasoningLevels: item.levels } : {} },
        })
        added += 1
      }
    }

    const models = await prisma.providerModel.findMany({
      where: { providerId: id },
      orderBy: { modelId: 'asc' },
      select: { id: true, modelId: true, displayName: true, contextWindow: true, capabilities: true, enabled: true },
    })

    return reply.status(200).send({ provider: provider.slug, discovered: discovered.length, added, models })
  })

  /** 启用/停用某个模型（拉取到的模型不一定都想让学生选） */
  app.patch('/v1/providers/:id/models/:modelId', { preHandler: guard('RUN_EXECUTE') }, async (request) => {
    const auth = getAuth(request)
    const { id, modelId } = request.params as { id: string; modelId: string }
    const body = parse(z.object({ enabled: z.boolean() }), request.body)

    const provider = await prisma.provider.findFirst({ where: { id, OR: [{ isCustom: false }, { ownerId: auth.user.id }] } })
    if (!provider) throw new AppError(404, 'PROVIDER_NOT_FOUND', '供应商不存在')

    const updated = await prisma.providerModel.update({
      where: { providerId_modelId: { providerId: id, modelId } },
      data: { enabled: body.enabled },
      select: { id: true, modelId: true, enabled: true },
    })
    return updated
  })

  /** 给自定义供应商补一个模型。 */
  app.post('/v1/providers/:id/models', { preHandler: guard('RUN_EXECUTE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const body = parse(z.object({ modelId: z.string().min(1).max(120), displayName: z.string().max(120).optional() }), request.body)

    const provider = await prisma.provider.findFirst({ where: { id, OR: [{ isCustom: false }, { ownerId: auth.user.id }] } })
    if (!provider) throw new AppError(404, 'PROVIDER_NOT_FOUND', '供应商不存在')

    const model = await prisma.providerModel.upsert({
      where: { providerId_modelId: { providerId: id, modelId: body.modelId } },
      create: { providerId: id, modelId: body.modelId, displayName: body.displayName ?? body.modelId, contextWindow: 0, capabilities: {} },
      update: { enabled: true },
      select: { id: true, modelId: true, displayName: true },
    })
    return reply.status(201).send(model)
  })

  /** 保存密钥（新增或覆盖同 label）。明文只在这里出现一次。 */
  app.post('/v1/providers/:id/credentials', { preHandler: guard('RUN_EXECUTE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const body = parse(createCredentialBody, request.body)
    const masterKey = requireMasterKey()

    const provider = await prisma.provider.findFirst({
      where: { id, OR: [{ isCustom: false }, { ownerId: auth.user.id }] },
    })
    if (!provider) throw new AppError(404, 'PROVIDER_NOT_FOUND', '供应商不存在')
    if (!provider.byokEnabled) throw new AppError(403, 'PROVIDER_BYOK_DISABLED', '该供应商不接受自带密钥')

    const apiKey = body.apiKey.trim()
    // 长度兜底：Ollama 这类本地端点可以不要 key，但真填了就得像个 key
    if (provider.keyRequired && apiKey.length < 4) {
      throw new AppError(400, 'PROVIDER_KEY_INVALID', '密钥太短')
    }

    let ciphertext: string
    try {
      ciphertext = encryptSecret(apiKey, masterKey)
    } catch (error) {
      throw new AppError(409, 'BYOK_MASTER_KEY_MISSING', error instanceof Error ? error.message : String(error))
    }

    const record = await prisma.userCredential.upsert({
      where: { userId_providerId_label: { userId: auth.user.id, providerId: id, label: body.label } },
      create: {
        userId: auth.user.id,
        providerId: id,
        label: body.label,
        ciphertext,
        last4: last4(apiKey),
        baseUrlOverride: body.baseUrlOverride ?? null,
        status: 'UNVERIFIED',
        isActive: true,
      },
      update: {
        ciphertext,
        last4: last4(apiKey),
        baseUrlOverride: body.baseUrlOverride ?? null,
        status: 'UNVERIFIED',
        isActive: true,
      },
      select: { id: true, label: true, last4: true, status: true, baseUrlOverride: true, createdAt: true },
    })

    return reply.status(201).send(record)
  })

  app.delete('/v1/credentials/:id', { preHandler: guard('RUN_EXECUTE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }

    const record = await prisma.userCredential.findFirst({ where: { id, userId: auth.user.id }, select: { id: true } })
    if (!record) throw new AppError(404, 'PROVIDER_CREDENTIAL_NOT_FOUND', '凭据不存在')

    await prisma.userCredential.delete({ where: { id } })
    return reply.status(204).send()
  })

  /**
   * 某个任务类型用哪个模型。
   * 规格「三个产品问题」②：选了能力不够的模型 → **保存即拒绝**，并说明缺哪项能力。
   */
  app.put('/v1/preferences/:taskType', { preHandler: guard('RUN_EXECUTE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { taskType } = request.params as { taskType: string }
    if (!(taskType in REQUIRED_CAPABILITY)) {
      throw new AppError(400, 'TASK_TYPE_UNKNOWN', `未知任务类型：${taskType}`)
    }
    const body = parse(prefBody, request.body)

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
      // 厂商没声明能力时允许选（打 UNTESTED，首次失败再给提示）；
      // 明确声明了但不满足，就在这里拒绝 —— 不要等整条链路跑完才让用户发现产物作废。
      const declared = Object.keys(caps).some(key => key !== 'reasoningLevels')
      if (declared && caps[needed] !== true) {
        throw new AppError(
          400,
          'MODEL_CAPABILITY_MISMATCH',
          `该任务需要 ${needed} 能力，而 ${model.displayName} 未声明支持`,
          { required: needed, model: body.modelId },
        )
      }
    }

    const pref = await prisma.userModelPref.upsert({
      where: { userId_taskType: { userId: auth.user.id, taskType } },
      create: { userId: auth.user.id, taskType, credentialId: body.credentialId, modelId: body.modelId },
      update: { credentialId: body.credentialId, modelId: body.modelId },
    })

    return reply.status(201).send({ taskType: pref.taskType, credentialId: pref.credentialId, modelId: pref.modelId })
  })

  app.delete('/v1/preferences/:taskType', { preHandler: guard('RUN_EXECUTE') }, async (request, reply) => {
    const auth = getAuth(request)
    const { taskType } = request.params as { taskType: string }
    await prisma.userModelPref.deleteMany({ where: { userId: auth.user.id, taskType } })
    return reply.status(204).send()
  })
}
