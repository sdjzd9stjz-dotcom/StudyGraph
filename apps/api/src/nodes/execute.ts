import { computeFingerprint } from '../../../../packages/contracts/src/index.ts'
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
  readonly port: string
}

async function collectInputs(
  prisma: PrismaClient,
  canvasId: string,
  nodeId: string,
): Promise<{ inputs: Record<string, unknown>; hashes: string[] }> {
  const edges = await prisma.edge.findMany({
    where: { canvasId, toNodeId: nodeId, kind: 'DERIVED_FROM' },
    select: { fromNodeId: true, toPort: true },
  })
  if (edges.length === 0) return { inputs: {}, hashes: [] }

  const artifacts: UpstreamArtifact[] = []
  for (const edge of edges) {
    const artifact = await prisma.artifact.findFirst({
      where: { nodeId: edge.fromNodeId },
      orderBy: { createdAt: 'desc' },
      select: { hash: true, structured: true },
    })
    if (artifact) artifacts.push({ hash: artifact.hash, structured: artifact.structured, port: edge.toPort })
  }

  const inputs: Record<string, unknown> = {}
  for (const artifact of artifacts) {
    const structured = artifact.structured as Record<string, unknown> | null
    if (structured && typeof structured === 'object') Object.assign(inputs, structured)
  }

  return { inputs, hashes: artifacts.map((artifact) => artifact.hash) }
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

  const { inputs, hashes } = await collectInputs(deps.prisma, node.canvasId, node.id)

  // 指纹输入：默认是 params；source 这类执行器会把文件内容摘要并进来（SG-SUP-008 §1）
  const fingerprintParams = executor.prepareFingerprintParams
    ? await executor.prepareFingerprintParams(node.params)
    : (node.params ?? {})

  const route = node.type === 'EXTRACT' ? deps.llm.routeFor('extract') : null
  const modelUsed = route ? `${route.provider}/${route.model}` : null
  // An alias alone cannot prove which provider snapshot will answer the next request.
  const expectedVersion = route?.expectedVersion ?? route?.model ?? 'rule-based-v1'
  const fingerprintFor = (version: string) => computeFingerprint({
    upstreamArtifactHashes: hashes,
    params: route ? { params: fingerprintParams, modelUsed } : fingerprintParams,
    modelVersion: version,
    promptVersion: executor.promptVersion,
  })
  let fingerprint = fingerprintFor(expectedVersion)
  const cacheHit = node.fingerprint === fingerprint

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
      inputs,
      llm: deps.llm,
      spans: {
        resolve: async () => null,
        pageText: async () => undefined,
        verify: async () => ({ ok: false, reason: 'PAGE_MISSING', detail: '执行器未提供 span 解析' }),
      },
      user: deps.user,
      prisma: deps.prisma,
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
        })),
      })
    }
    const versions = [...new Set(result.usageRecords?.map(record => record.model))]
    if (route && versions.length !== 1) throw new Error('一次运行需要唯一可核验的模型版本')
    const modelVersion = route ? versions[0]! : expectedVersion
    fingerprint = fingerprintFor(modelVersion)
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
    await deps.prisma.run.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        endedAt: new Date(),
        errorCode: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error),
      },
    })
    await deps.prisma.node.update({
      where: { id: node.id },
      data: { status: 'ERROR', errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error) },
    })
    throw error
  }
}

/** 生产用的 Gateway 构造（BYOK → env）。 */
export function buildGateway(resolveApiKey: ApiKeyResolver, logger: { debug: (obj: unknown, msg?: string) => void }): LLMGateway {
  return createGateway({ resolveApiKey, logger })
}
