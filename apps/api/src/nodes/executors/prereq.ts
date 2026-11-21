import type { JSONSchema, TokenUsage } from '../../llm/types.ts'
import { isAcyclic } from '../../domain/graph/dag.ts'
import type { EdgeLike } from '../../domain/graph/dag.ts'
import { composeSystemPrompt, HARD_RULE_SUMMARY } from '../skills.ts'
import type { NodeExecutor } from '../contract.ts'
import { ZERO_USAGE } from '../contract.ts'

/**
 * `prereq` 执行器（M3）：在已有概念之间提议**先修关系**。
 *
 * 三条硬性约束，每条都对应一种会让知识图变成垃圾的失败：
 *
 * 1. **只能是 PROPOSED**。模型推断的先修关系不等于教学事实，必须由 Gate 人工确认。
 *    直接写 CONFIRMED 会让"学 A 之前要先学 B"变成没人复核过的系统结论。
 * 2. **必须带证据 span**。证据取自 from 概念自己的主引用 —— 不让模型编造引文，
 *    也不再去原文里找一段它没看过的位置。
 * 3. **不许造环**。A→B→C→A 的先修链是无意义的，且会让"按先修排序"直接死循环。
 *    新边如果让图成环，逐条丢弃并记进 skipped。
 *
 * 这个执行器**不写 Concept**：它只提议边，不动概念本身。
 */

const SYSTEM_PROMPT = `你是教学法助手。给定一组已经确认的课程概念（含定义），
找出「要理解后者，必须先理解前者」的先修关系。

规则：
- 只能使用给定概念名，不许编新概念
- 只给出**确有先修必要性**的配对；宁可少给，不要凑数
- rationale 用一句话说明为什么后者依赖前者
- 不许输出自环（概念不能是自己先修自己）`

/** 单次最多处理的概念数：太多会让模型凑配对，太少会漏关系 */
const MAX_CONCEPTS = 40

interface ProposedPair {
  readonly from: string
  readonly to: string
  readonly rationale: string
}

const outputSchema: JSONSchema = {
  type: 'object',
  properties: {
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['from', 'to', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['pairs'],
  additionalProperties: false,
}

export const prereqExecutor: NodeExecutor = {
  type: 'PREREQ',
  artifactKind: 'PREREQ_GRAPH',
  promptVersion: 'prereq-v1',
  inputs: { type: 'object', properties: { cards: { type: 'object', description: '上游 card 节点产物（可选）' } }, required: [] },
  outputs: {
    type: 'object',
    properties: { proposed: { type: 'number' }, skipped: { type: 'array' } },
    required: ['proposed', 'skipped'],
  },

  async run(ctx) {
    const concepts = await ctx.prisma.concept.findMany({
      where: { canvasId: ctx.canvasId, status: { in: ['VERIFIED', 'PENDING_REVIEW'] } },
      orderBy: { name: 'asc' },
      take: MAX_CONCEPTS,
      select: {
        id: true,
        name: true,
        definition: true,
        citations: { where: { isPrimary: true }, take: 1, select: { spanId: true } },
      },
    })

    if (concepts.length < 2) {
      throw new Error('先修关系至少需要两个已确认的概念；当前不足，请先跑 card 节点')
    }

    const nameToConcept = new Map(concepts.map((concept) => [concept.name, concept]))
    const listing = concepts
      .map((concept, index) => `${index + 1}. ${concept.name}：${concept.definition}`)
      .join('\n')

    const result = await ctx.llm.complete({
      taskType: 'method',
      messages: [
        { role: 'system', content: composeSystemPrompt(HARD_RULE_SUMMARY, ctx.skills, SYSTEM_PROMPT) },
        { role: 'user', content: listing },
      ],
      jsonSchema: outputSchema,
      user: ctx.user,
    })

    const usage: TokenUsage = result.usage
    const pairs = ((result.data as { pairs?: ProposedPair[] }).pairs ?? []).filter(
      (pair): pair is ProposedPair =>
        typeof pair?.from === 'string' && typeof pair?.to === 'string' && typeof pair?.rationale === 'string',
    )

    const skipped: Array<{ from: string; to: string; reason: string }> = []
    const accepted: Array<{ id: string; from: string; to: string; rationale: string }> = []

    // 现有边（含已确认的）用来判环：新边不能和它们一起成环
    const existing = await ctx.prisma.conceptEdge.findMany({
      where: { canvasId: ctx.canvasId, kind: 'PREREQUISITE' },
      select: { fromConceptId: true, toConceptId: true },
    })
    const working: EdgeLike[] = existing.map((edge) => ({ fromNodeId: edge.fromConceptId, toNodeId: edge.toConceptId, kind: 'PREREQUISITE' }))
    const conceptIds = concepts.map((concept) => concept.id)

    for (const pair of pairs) {
      const from = nameToConcept.get(pair.from)
      const to = nameToConcept.get(pair.to)

      if (!from || !to) {
        skipped.push({ from: pair.from, to: pair.to, reason: 'NAME_NOT_FOUND' })
        continue
      }
      if (from.id === to.id) {
        skipped.push({ from: pair.from, to: pair.to, reason: 'SELF_LOOP' })
        continue
      }

      const candidate: EdgeLike = { fromNodeId: from.id, toNodeId: to.id, kind: 'PREREQUISITE' }
      if (!isAcyclic(conceptIds, [...working, candidate])) {
        skipped.push({ from: pair.from, to: pair.to, reason: 'WOULD_CREATE_CYCLE' })
        continue
      }

      // 证据用 from 概念自己的主引用：模型没看过的原文片段不能拿来当证据
      const evidenceSpanId = from.citations[0]?.spanId ?? null
      if (!evidenceSpanId) {
        skipped.push({ from: pair.from, to: pair.to, reason: 'NO_EVIDENCE_SPAN' })
        continue
      }

      const edge = await ctx.prisma.conceptEdge.upsert({
        where: { fromConceptId_toConceptId_kind: { fromConceptId: from.id, toConceptId: to.id, kind: 'PREREQUISITE' } },
        create: {
          canvasId: ctx.canvasId,
          fromConceptId: from.id,
          toConceptId: to.id,
          kind: 'PREREQUISITE',
          status: 'PROPOSED',
          confidence: null,
          rationale: pair.rationale,
          evidenceSpanId,
          createdFromNodeId: ctx.nodeId,
        },
        // 已存在的边不覆盖人工确认结论：只补理由与出处
        update: { rationale: pair.rationale, evidenceSpanId, createdFromNodeId: ctx.nodeId },
        select: { id: true, fromConceptId: true, toConceptId: true, status: true },
      })

      working.push(candidate)
      accepted.push({ id: edge.id, from: pair.from, to: pair.to, rationale: pair.rationale })
    }

    return {
      outputs: {
        proposed: accepted.length,
        confirmedPreserved: existing.length,
        skipped,
        edges: accepted,
      },
      usage,
      usageRecords: [{ provider: result.provider, model: result.modelVersion, ...usage }],
    }
  },
}

