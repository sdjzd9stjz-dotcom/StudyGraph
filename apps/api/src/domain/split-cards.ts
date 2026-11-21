import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { defaultPortName, validateConnection } from '../../../../packages/contracts/src/index.ts'

/**
 * 按概念拆分知识卡（用户 2026-11-21 要求）。
 *
 * 用户的诉求不是"再生成一份摘要"，而是让画布长成一张知识图：
 * 一个概念 = 一张卡 = 一个节点，每个节点还能继续对话、继续被下游引用。
 * 一个 CARD 节点塞 15 张卡时，对话只能围绕"这一堆"，下游也没法针对单个概念取上下文。
 *
 * 规则：
 *   · 只为**有可引用 span** 的 claim 建卡（没有出处的概念不建 —— 和 CARD 执行器一致）
 *   · 已经拆过的概念不重复建（按 params.conceptName 判重）
 *   · 连线一律 EXTRACT → CARD，端口用 contracts 的默认端口并校验
 *   · 新节点都是 DRAFT：拆出来不等于跑过
 */

export interface SplitOutcome {
  readonly created: Array<{ id: string; title: string; conceptName: string }>
  readonly skipped: Array<{ name: string; reason: string }>
  readonly extractNodeId: string
}

interface ClaimShape {
  name?: unknown
  status?: unknown
  spanIds?: unknown
}

export async function splitCardsForConcepts(
  prisma: PrismaClient,
  input: { canvasId: string; extractNodeId: string },
): Promise<SplitOutcome> {
  const extract = await prisma.node.findFirst({
    where: { id: input.extractNodeId, canvasId: input.canvasId, type: 'EXTRACT' },
    select: { id: true, posX: true, posY: true },
  })
  if (!extract) throw new Error('这个节点不是当前画布上的概念抽取节点')

  const artifact = await prisma.artifact.findFirst({
    where: { nodeId: extract.id },
    orderBy: { createdAt: 'desc' },
    select: { kind: true, structured: true },
  })
  const claims = (artifact?.structured as { conceptClaims?: { claims?: ClaimShape[] } } | null)?.conceptClaims?.claims
  if (!Array.isArray(claims) || claims.length === 0) {
    throw new Error('这个节点还没有抽取出概念（先运行一次概念抽取）')
  }

  // 已拆过的概念：同一个概念不建第二个卡节点
  const existingCards = await prisma.node.findMany({
    where: { canvasId: input.canvasId, type: 'CARD' },
    select: { id: true, params: true },
  })
  const already = new Set<string>()
  for (const card of existingCards) {
    const name = (card.params as { conceptName?: unknown } | null)?.conceptName
    if (typeof name === 'string' && name.trim().length > 0) already.add(name.trim())
  }

  const created: SplitOutcome['created'][number][] = []
  const skipped: SplitOutcome['skipped'] = []
  const spanIds = new Set<string>()
  let index = 0

  for (const claim of claims) {
    const name = typeof claim.name === 'string' ? claim.name.trim() : ''
    if (name.length === 0) continue
    if (claim.status === 'UNVERIFIED' || !Array.isArray(claim.spanIds) || claim.spanIds.length === 0) {
      skipped.push({ name, reason: '没有可引用的原文片段' })
      continue
    }
    if (already.has(name)) {
      skipped.push({ name, reason: '已经拆过了' })
      continue
    }

    // 网格排布：每列 4 张，列间距 320，行间距 190，从抽取节点右侧开始
    const column = Math.floor(index / 4)
    const row = index % 4
    const node = await prisma.node.create({
      data: {
        canvasId: input.canvasId,
        type: 'CARD',
        title: name.slice(0, 200),
        params: { conceptName: name } as object,
        status: 'DRAFT',
        posX: extract.posX + 340 + column * 320,
        posY: extract.posY + row * 190,
      },
      select: { id: true, title: true },
    })

    const fromPort = defaultPortName('EXTRACT', 'output')
    const toPort = defaultPortName('CARD', 'input')
    const check = validateConnection({
      fromType: 'EXTRACT',
      fromPort: fromPort ?? '',
      toType: 'CARD',
      toPort: toPort ?? '',
    })
    if (check.ok) {
      await prisma.edge.create({
        data: {
          canvasId: input.canvasId,
          fromNodeId: extract.id,
          toNodeId: node.id,
          kind: 'DERIVED_FROM',
          ...(fromPort ? { fromPort } : {}),
          ...(toPort ? { toPort } : {}),
        },
      })
    }

    const claimSpan = claim.spanIds[0]
    if (typeof claimSpan === 'string') spanIds.add(claimSpan)
    created.push({ id: node.id, title: node.title ?? name, conceptName: name })
    already.add(name)
    index += 1
  }

  return { created, skipped, extractNodeId: extract.id }
}
