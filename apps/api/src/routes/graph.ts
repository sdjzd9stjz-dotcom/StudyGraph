import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { currentMastery } from '../domain/fsrs.ts'
import { findCanvasForUser } from '../lib/access.ts'
import { viewNotImplemented } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

const querySchema = z.object({
  view: z.enum(['pipeline', 'knowledge', 'method']).default('pipeline'),
})

/** 未实现的视图明确 501，并说明计划节点。不许返回空数组冒充"没有数据"。 */
const VIEW_PLAN = {
  knowledge: 'M3',
  method: 'M5',
} as const

export interface GraphRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
}

export function registerGraphRoutes(app: FastifyInstance, deps: GraphRouteDeps): void {
  const { prisma, guard } = deps

  app.get('/v1/canvases/:id/graph', { preHandler: guard('CANVAS_READ') }, async (request) => {
    const auth = getAuth(request)
    const { id } = request.params as { id: string }
    const { view } = parse(querySchema, request.query)

    await findCanvasForUser(prisma, id, auth.user.id)

    // ── 知识视图（M3）：概念节点 + 先修边，带当前掌握度 ──────────────────
    // 与 pipeline 的区别：pipeline 画的是"数据怎么流"（节点与端口），
    // knowledge 画的是"这个概念要先学什么"（概念与先修关系），两者不是一张图。
    if (view === 'knowledge') {
      const [concepts, conceptEdges] = await Promise.all([
        prisma.concept.findMany({
          where: { canvasId: id },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            definition: true,
            status: true,
            mastery: true,
            dueAt: true,
            lastReviewedAt: true,
            reps: true,
            lapses: true,
            fsrsState: true,
          },
        }),
        prisma.conceptEdge.findMany({
          where: { canvasId: id, kind: 'PREREQUISITE' },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            fromConceptId: true,
            toConceptId: true,
            status: true,
            confidence: true,
            rationale: true,
            evidenceSpanId: true,
          },
        }),
      ])

      const now = new Date()
      const nodes = concepts.map((concept) => {
        const stored = (concept.fsrsState ?? {}) as { stability?: number; state?: string }
        // 掌握度用**当前**可提取性，不是上次复习时的快照 ——
        // 热力图要反映"现在还记得多少"，否则长期不复习的卡看着还是满分。
        const mastery = concept.lastReviewedAt
          ? currentMastery(
              {
                stability: stored.stability ?? 0,
                difficulty: 5,
                state: 'REVIEW',
                lastReviewedAt: concept.lastReviewedAt,
              },
              now,
            )
          : 0
        return {
          id: concept.id,
          name: concept.name,
          definition: concept.definition,
          status: concept.status,
          mastery,
          dueAt: concept.dueAt,
          lastReviewedAt: concept.lastReviewedAt,
          reps: concept.reps,
          lapses: concept.lapses,
        }
      })

      const byMastery = { new: 0, weak: 0, okay: 0, strong: 0 }
      for (const node of nodes) {
        if (node.lastReviewedAt === null) byMastery.new += 1
        else if (node.mastery < 0.6) byMastery.weak += 1
        else if (node.mastery < 0.85) byMastery.okay += 1
        else byMastery.strong += 1
      }

      return {
        view,
        canvasId: id,
        nodes,
        edges: conceptEdges,
        stats: {
          conceptCount: nodes.length,
          edgeCount: conceptEdges.length,
          proposedEdges: conceptEdges.filter((edge) => edge.status === 'PROPOSED').length,
          byMastery,
        },
      }
    }

    // ── 方法视图（M5）：方法节点 + 它们各自依赖哪些概念 ──────────────────
    // 与 knowledge 的区别：knowledge 画"概念要先学什么"，method 画
    // "这类题该用哪个方法、用哪个方法需要先掌握哪些概念"。
    if (view === 'method') {
      const [methods, methodEdges, links, applications] = await Promise.all([
        prisma.method.findMany({
          where: { canvasId: id },
          orderBy: [{ proficiency: 'desc' }, { name: 'asc' }],
          select: {
            id: true,
            name: true,
            summary: true,
            status: true,
            proficiency: true,
            trigger: true,
            conditions: true,
            lastUsedAt: true,
          },
        }),
        prisma.methodEdge.findMany({
          where: { canvasId: id },
          select: { id: true, fromMethodId: true, toMethodId: true, kind: true },
        }),
        prisma.methodConcept.findMany({
          where: { method: { canvasId: id } },
          select: { methodId: true, conceptId: true, isCore: true, concept: { select: { name: true, mastery: true } } },
        }),
        // 熟练度的原始观测：proficiency 是 MethodApplication 的派生量，不是手填字段
        prisma.methodApplication.groupBy({
          by: ['methodId', 'isCorrect', 'isMisuse'],
          where: { method: { canvasId: id } },
          _count: { _all: true },
        }),
      ])

      const statsFor = (methodId: string) => {
        let reps = 0
        let successes = 0
        let misuse = 0
        for (const row of applications) {
          if (row.methodId !== methodId) continue
          reps += row._count._all
          if (row.isCorrect) successes += row._count._all
          if (row.isMisuse) misuse += row._count._all
        }
        return { reps, successes, lapses: reps - successes, misuse }
      }

      const byProficiency = { untried: 0, weak: 0, okay: 0, strong: 0 }
      for (const method of methods) {
        // 从没用过的方法不能算"会"，哪怕 proficiency 是 0
        if (statsFor(method.id).reps === 0) byProficiency.untried += 1
        else if (method.proficiency < 0.4) byProficiency.weak += 1
        else if (method.proficiency < 0.75) byProficiency.okay += 1
        else byProficiency.strong += 1
      }

      return {
        view,
        canvasId: id,
        nodes: methods.map((method) => ({
          id: method.id,
          name: method.name,
          summary: method.summary,
          status: method.status,
          proficiency: method.proficiency,
          trigger: method.trigger,
          conditions: method.conditions,
          ...statsFor(method.id),
          lastUsedAt: method.lastUsedAt,
          concepts: links
            .filter((link) => link.methodId === method.id)
            .map((link) => ({ conceptId: link.conceptId, name: link.concept.name, mastery: link.concept.mastery, isCore: link.isCore })),
        })),
        edges: methodEdges,
        stats: {
          methodCount: methods.length,
          edgeCount: methodEdges.length,
          byProficiency,
          // 双熟练度模型：概念掌握度（记忆）与方法熟练度（解题）是两套变量，
          // 这里把"概念还没掌握却已经有方法"的配对挑出来，是学生最容易踩的坑
          conceptReadyButMethodUnproven: links.filter((link) => link.isCore && link.concept.mastery >= 0.6).length,
        },
      }
    }

    if (view !== 'pipeline') {
      throw viewNotImplemented(view, VIEW_PLAN[view])
    }

    const [nodes, edges] = await Promise.all([
      prisma.node.findMany({
        where: { canvasId: id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          type: true,
          title: true,
          status: true,
          posX: true,
          posY: true,
          staleAt: true,
          staleReason: true,
        },
      }),
      prisma.edge.findMany({
        where: { canvasId: id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, fromNodeId: true, toNodeId: true, kind: true, fromPort: true, toPort: true },
      }),
    ])

    return { view, canvasId: id, nodes, edges }
  })
}
