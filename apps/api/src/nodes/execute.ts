import { nodeModelTask } from '../../../../packages/contracts/src/reasoning.ts'
import { forOperation } from '../llm/reasoning.ts'
import type { CheckParams } from './executors/check.ts'
import type { QuizQuestionRef } from './contract.ts'
import { verifiedPaperPool } from '../domain/verified-paper.ts'
import { createHash } from 'node:crypto'

import { computeFingerprint } from '../../../../packages/contracts/src/index.ts'
import { summarizeArtifact } from '../domain/artifact-text.ts'
import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { AppError } from '../lib/errors.ts'
import { createGateway } from '../llm/gateway.ts'
import type { ApiKeyResolver } from '../llm/credentials.ts'
import type { LLMGateway } from '../llm/types.ts'
import type { UserCtx } from '../llm/user.ts'
import type { ObjectStore } from '../storage/object-store.ts'
import { collectDownstream } from '../domain/graph/dag.ts'
import type { EdgeLike } from '../domain/graph/dag.ts'
import { getExecutor } from './registry.ts'
import { loadNodeSkills, skillFingerprintPayload, withNodePrompt } from './skills.ts'
import { cardCacheIsCurrent } from './executors/card.ts'

/**
 * 执行链路（M2 版，同步执行）。
 *
 * 顺序：取执行器 → 收集上游产物 → 算指纹 → 命中缓存则零成本返回 →
 *       否则执行 → 落产物 → 更新节点状态 → 下游标 stale（**不执行**）。
 *
 * 语义要点：
 * - `dryRun` 不写库、不调模型，只返回估算与是否命中缓存
 * - 指纹命中时 `Run.cacheHit = true`、`tokensIn/Out = 0`
 * - 跑完只把**下游**标 `STALE`，绝不自动重跑（硬约束 2）
 * - 尚未实现的节点由 `getExecutor` 抛 501，这里不兜底
 */
export interface ExecuteDeps {
  readonly prisma: PrismaClient
  readonly objectStore: ObjectStore
  readonly llm: LLMGateway
  readonly user: UserCtx
}

export interface RunOutcome {
  readonly runId: string | null
  readonly nodeId: string
  readonly status: 'SUCCEEDED' | 'CACHED' | 'DRY_RUN'
  readonly cacheHit: boolean
  readonly tokensIn: number
  readonly tokensOut: number
  readonly fingerprint: string
  readonly staleDownstream: string[]
}

interface UpstreamArtifact {
  readonly hash: string
  readonly structured: unknown
  readonly kind: string
  readonly port: string
}

/**
 * 上游节点带进下游的「对话上下文」。
 *
 * 连线不再只是"把产物递给下游"：每个上游节点本身是一个会话，
 * 它的产出摘要 + 最近几轮对话会一起进入下游提示词（用户 2026-11-21 要求）。
 */
export interface UpstreamContextEntry {
  readonly nodeId: string
  readonly type: string
  readonly title: string
  readonly artifactKind: string | null
  readonly summary: string
  readonly conversation: string
  readonly port: string
}

async function collectInputs(
  prisma: PrismaClient,
  canvasId: string,
  nodeId: string,
): Promise<{ inputs: Record<string, unknown>; hashes: string[]; quizBatch: QuizQuestionRef[] }> {
  const edges = await prisma.edge.findMany({
    where: { canvasId, toNodeId: nodeId, kind: 'DERIVED_FROM' },
    select: { fromNodeId: true, toPort: true },
  })

  /**
   * 分组上下文：这个节点引用了哪些组，组里有哪些成员。
   *
   * 用户要求「把一部分节点打包成一个节点，用来做其它节点的上下文」。
   * 打包时必须真的影响执行结果，否则它只是画布上的一个虚线框、没有任何作用。
   *
   * 成员的产物**按 fromNodeId 顺序**合并，保证同一组成员得到同样的输入
   * （否则指纹会随查询顺序抖动，缓存永远命中不了）。
   */
  const groupLinks = await prisma.nodeGroupLink.findMany({
    where: { nodeId, group: { canvasId } },
    orderBy: { groupId: 'asc' },
    select: { groupId: true, group: { select: { members: { select: { nodeId: true }, orderBy: { nodeId: 'asc' } } } } },
  })

  const upstreamNodeIds = [
    ...edges.map((edge) => edge.fromNodeId),
    ...groupLinks.flatMap((link) => link.group.members.map((member) => member.nodeId)),
  ]

  if (upstreamNodeIds.length === 0) return { inputs: {}, hashes: [], quizBatch: [] }

  // 去重 + 排序：产物合并与指纹都不能随数据库返回顺序抖动
  const uniqueUpstreamIds = [...new Set(upstreamNodeIds)].filter((id) => id !== nodeId).sort()
  const portByNode = new Map(edges.map((edge) => [edge.fromNodeId, edge.toPort]))

  const [artifactRows, upstreamNodes, messageRows] = await Promise.all([
    prisma.artifact.findMany({
      where: { nodeId: { in: uniqueUpstreamIds } },
      orderBy: { createdAt: 'desc' },
      select: { nodeId: true, hash: true, structured: true, kind: true },
    }),
    prisma.node.findMany({
      where: { id: { in: uniqueUpstreamIds } },
      select: { id: true, type: true, title: true },
    }),
    prisma.nodeMessage.findMany({
      where: { nodeId: { in: uniqueUpstreamIds } },
      orderBy: { createdAt: 'asc' },
      select: { nodeId: true, role: true, content: true },
    }),
  ])

  // 每个节点只取最新一条产物
  const latestArtifact = new Map<string, (typeof artifactRows)[number]>()
  for (const row of artifactRows) {
    if (!latestArtifact.has(row.nodeId)) latestArtifact.set(row.nodeId, row)
  }
  const nodeById = new Map(upstreamNodes.map((node) => [node.id, node]))

  const messagesByNode = new Map<string, string[]>()
  for (const row of messageRows) {
    const list = messagesByNode.get(row.nodeId) ?? []
    const who = row.role === 'user' ? '用户' : '助手'
    list.push(`${who}：${row.content.replace(/\s+/g, ' ').trim()}`)
    messagesByNode.set(row.nodeId, list)
  }

  const artifacts: UpstreamArtifact[] = []
  const inputs: Record<string, unknown> = {}
  const upstreamContext: UpstreamContextEntry[] = []
  const quizBatch: QuizQuestionRef[] = []

  for (const upstreamId of uniqueUpstreamIds) {
    const artifact = latestArtifact.get(upstreamId)

    if (artifact) {
      artifacts.push({
        hash: artifact.hash,
        structured: artifact.structured,
        kind: artifact.kind,
        port: portByNode.get(upstreamId) ?? 'context',
      })
      const structured = artifact.structured as Record<string, unknown> | null
      if (structured && typeof structured === 'object') Object.assign(inputs, structured)
      if (portByNode.has(upstreamId) && nodeById.get(upstreamId)?.type === 'QUIZ' && artifact.kind === 'PROBLEM_DRAFT' && Array.isArray(structured?.created)) {
        for (const question of structured.created) {
          if (typeof question?.id === 'string') quizBatch.push({ id: question.id, sourceNodeId: upstreamId })
        }
      }
    }

    /**
     * 「连线」的第二层含义（用户 2026-11-21 要求）：
     * 下游拿到的不只是上游的产物，还有**上游这个节点自己的对话总结**。
     * 没有对话的节点只带产物摘要；两者都没有就不进上下文（不占提示词）。
     */
    const conversation = (messagesByNode.get(upstreamId) ?? []).slice(-8).join('\n').slice(0, 1600)
    const summary = artifact ? summarizeArtifact(artifact.kind, artifact.structured).slice(0, 1200) : ''
    if (summary.length > 0 || conversation.length > 0) {
      const node = nodeById.get(upstreamId)
      upstreamContext.push({
        nodeId: upstreamId,
        type: node?.type ?? '',
        title: node?.title ?? node?.type ?? upstreamId,
        artifactKind: artifact?.kind ?? null,
        summary,
        conversation,
        port: portByNode.get(upstreamId) ?? 'context',
      })
    }
  }

  if (upstreamContext.length > 0) inputs.upstreamContext = upstreamContext

  // 分组来源单独列出来：执行器要区分"这是直接上游"还是"这是打包来的上下文"
  if (groupLinks.length > 0) {
    inputs.groupContext = groupLinks.map((link) => ({
      groupId: link.groupId,
      memberIds: link.group.members.map((member) => member.nodeId),
    }))
  }

  /**
   * 指纹要把上游对话算进去：用户在上游追问了两轮，下游的"上下文"就不一样了。
   * 只算产物哈希的话，改了对话还能命中缓存，下游永远看不到新总结。
   */
  const conversationHashes = upstreamContext
    .filter((entry) => entry.conversation.length > 0)
    .map((entry) => createHash('sha256').update(`${entry.nodeId}\n${entry.conversation}`).digest('hex'))

  return { inputs, quizBatch, hashes: [...artifacts.map((artifact) => artifact.hash), ...conversationHashes] }
}

export async function executeNode(
  deps: ExecuteDeps,
  nodeId: string,
  options: { dryRun: boolean },
): Promise<RunOutcome> {
  const node = await deps.prisma.node.findUnique({
    where: { id: nodeId },
    select: { id: true, canvasId: true, type: true, params: true, fingerprint: true },
  })
  if (!node) throw new AppError(404, 'NODE_NOT_FOUND', '节点不存在', { nodeId })

  // 未实现 → 501（由 registry 决定，这里不吞）
  const executor = getExecutor(node.type)

  const { inputs, hashes, quizBatch } = await collectInputs(deps.prisma, node.canvasId, node.id)

  // 组卷读取整张画布的可用题库；上下游节点没有变化时，题目也可能刚刚通过质检或被降级。
  const paperPool = node.type === 'PAPER' ? await verifiedPaperPool(deps.prisma, node.canvasId) : undefined
  if (paperPool) hashes.push(createHash('sha256').update(JSON.stringify(paperPool)).digest('hex'))

  // 指纹输入：默认是 params；source 这类执行器会把文件内容摘要并进来（SG-SUP-008 §1）
  const fingerprintParams = executor.prepareFingerprintParams
    ? await executor.prepareFingerprintParams(node.params)
    : (node.params ?? {})

  // F2：显式绑定到本节点的 skill（已过滤 enabled=false、按 slug 排序）
  const boundSkills = await loadNodeSkills(deps.prisma, node.id, deps.user.id)

  // 节点自己写的提示词（`params.prompt`）：合成为附加 skill，见 withNodePrompt 的说明
  const skills = withNodePrompt(boundSkills, (node.params as { prompt?: unknown } | null)?.prompt)
  const skillPayload = skillFingerprintPayload(skills)

  const user = { ...deps.user, canvasId: node.canvasId }
  const task = nodeModelTask(node.type)
  const llm = task ? await forOperation(deps.llm, task, user, `run:${node.id}`) : deps.llm
  const route = task ? await (llm.selectedRoute?.(task, user) ?? llm.routeFor(task)) : null
  const modelUsed = route ? `${route.provider}/${route.model}` : null
  // An alias alone cannot prove which provider snapshot will answer the next request.
  const expectedVersion = route?.expectedVersion ?? route?.model ?? 'rule-based-v1'
  const fingerprintFor = (version: string) => computeFingerprint({
    upstreamArtifactHashes: hashes,
    // skill 的 slug+version 进指纹：绑了新 skill 或改了正文都必须让缓存失效。
    // 只放 slug+version 而不是全文 —— 正文改了 version 就会 +1，没必要把正文也塞进来。
    params: route
      ? { params: fingerprintParams, modelUsed, skills: skillPayload, ...(llm.effort ? { effort: llm.effort } : {}) }
      : { params: fingerprintParams, skills: skillPayload },
    modelVersion: version,
    promptVersion: executor.promptVersion,
  })
  let fingerprint = fingerprintFor(expectedVersion)
  // 联机质检要重新读取每道题的现态；已经给过结论的题不会重复调用模型。
  const checkParams = node.params as CheckParams | null
  const checksStoredQuestions = node.type === 'CHECK' && quizBatch.length > 0 &&
    !checkParams?.stem?.trim() && !checkParams?.answer?.trim()
  const cacheHit = node.fingerprint === fingerprint && !checksStoredQuestions &&
    (node.type !== 'CARD' || await cardCacheIsCurrent(deps.prisma, node.id, node.canvasId))

  if (options.dryRun) {
    return {
      runId: null,
      nodeId: node.id,
      status: 'DRY_RUN',
      cacheHit,
      tokensIn: 0,
      tokensOut: 0,
      fingerprint,
      staleDownstream: [],
    }
  }

  // 命中缓存：复用最近一次产物，零 token
  if (cacheHit) {
    const run = await deps.prisma.run.create({
      data: {
        nodeId: node.id,
        status: 'SUCCEEDED',
        trigger: 'user',
        fingerprint,
        modelUsed, modelVersion: expectedVersion, promptVersion: executor.promptVersion,
        cacheHit: true,
        tokensIn: 0,
        tokensOut: 0,
        startedAt: new Date(),
        endedAt: new Date(),
      },
      select: { id: true },
    })
    return {
      runId: run.id,
      nodeId: node.id,
      status: 'CACHED',
      cacheHit: true,
      tokensIn: 0,
      tokensOut: 0,
      fingerprint,
      staleDownstream: [],
    }
  }

  const run = await deps.prisma.run.create({
    data: { nodeId: node.id, status: 'RUNNING', trigger: 'user', fingerprint, startedAt: new Date() },
    select: { id: true },
  })

  await deps.prisma.node.update({ where: { id: node.id }, data: { status: 'RUNNING' } })

  try {
    const result = await executor.run({
      params: node.params,
      quizBatch,
      paperPool,
      inputs,
      llm,
      spans: {
        resolve: async () => null,
        pageText: async () => undefined,
        verify: async () => ({ ok: false, reason: 'PAGE_MISSING', detail: '执行器未提供 span 解析' }),
      },
      user,
      prisma: deps.prisma,
      skills,
      canvasId: node.canvasId,
      nodeId: node.id,
      objectStore: deps.objectStore,
    })

    const structured = result.outputs

    // D3：把每个模型的用量落 UsageRecord（cachedTokens 要能直接查到）
    if (result.usageRecords && result.usageRecords.length > 0) {
      await deps.prisma.usageRecord.createMany({
        data: result.usageRecords.map((record) => ({
          userId: deps.user.id,
          canvasId: node.canvasId,
          runId: run.id,
          surface: 'NODE_RUN' as never,
          provider: record.provider,
          model: record.model,
          tokensIn: record.tokensIn,
          tokensOut: record.tokensOut,
          cachedTokens: record.cachedTokens,
          cacheUsageComplete: record.cacheUsageComplete !== false,
        })),
      })
    }
    const versions = [...new Set(result.usageRecords?.map(record => record.model))]
    if (node.type === 'EXTRACT' && versions.length !== 1) throw new Error('一次运行需要唯一可核验的模型版本')
    const modelVersion = versions.length === 1 ? versions[0]! : expectedVersion
    fingerprint = fingerprintFor(node.type === 'EXTRACT' ? modelVersion : expectedVersion)
    const hash = computeFingerprint({
      upstreamArtifactHashes: [],
      params: structured,
      modelVersion: 'artifact',
      promptVersion: 'artifact',
    })

    await deps.prisma.artifact.create({
      data: {
        nodeId: node.id,
        runId: run.id,
        kind: executor.artifactKind as never,
        structured: structured as never,
        hash,
      },
    })

    await deps.prisma.run.update({
      where: { id: run.id },
      data: {
        status: 'SUCCEEDED',
        endedAt: new Date(),
        fingerprint, modelUsed, modelVersion, promptVersion: executor.promptVersion,
        tokensIn: result.usage.tokensIn,
        tokensOut: result.usage.tokensOut,
      },
    })

    await deps.prisma.node.update({
      where: { id: node.id },
      data: { status: 'READY', fingerprint, staleAt: null, staleReason: null, errorMessage: null },
    })

    // 下游只标 stale，不执行（硬约束 2）
    const edges = await deps.prisma.edge.findMany({
      where: { canvasId: node.canvasId },
      select: { fromNodeId: true, toNodeId: true, kind: true },
    })
    const downstream = collectDownstream(edges as EdgeLike[], node.id)
    if (downstream.length > 0) {
      await deps.prisma.node.updateMany({
        where: { id: { in: downstream } },
        data: { status: 'STALE', staleAt: new Date(), staleReason: `上游 ${node.id} 已更新` },
      })
    }

    return {
      runId: run.id,
      nodeId: node.id,
      status: 'SUCCEEDED',
      cacheHit: false,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      fingerprint,
      staleDownstream: downstream,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : String(error)
    await deps.prisma.run.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        endedAt: new Date(),
        errorCode: error instanceof AppError ? error.code : 'NODE_RUN_FAILED',
        errorMessage: message,
      },
    })
    await deps.prisma.node.update({
      where: { id: node.id },
      data: { status: 'ERROR', errorMessage: message },
    })

    /**
     * 执行器抛的普通 Error 也要带上原因返回。
     *
     * 之前原样往外抛，全局错误处理器把它当未知错误 → `500 服务器内部错误`，
     * 学生看不到"其实是没填题干"（实际遇到过，且完全无从下手）。
     * 这里包一层：状态码仍是 500（确实是执行失败，不是输入格式问题），
     * 但 message 用真实原因。用户可以自己修的输入问题由执行器抛 422，
     * 不走这条路径。
     */
    if (error instanceof AppError) throw error
    throw new AppError(500, 'NODE_RUN_FAILED', message, { nodeId: node.id, nodeType: node.type })
  }
}

/** 生产用的 Gateway 构造（BYOK → env）。 */
export function buildGateway(resolveApiKey: ApiKeyResolver, logger: { debug: (obj: unknown, msg?: string) => void }): LLMGateway {
  return createGateway({ resolveApiKey, logger })
}
