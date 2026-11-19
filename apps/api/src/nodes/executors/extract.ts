import { createHash } from 'node:crypto'

import { conceptClaimsSchema } from '../../../../../packages/contracts/src/index.ts'
import type { ChunkSet, ConceptClaims } from '../../../../../packages/contracts/src/index.ts'
import type { NodeExecutor } from '../contract.ts'

/**
 * `extract` 执行器（SG-SUP-009 §4.1）。
 *
 * 规则：
 * - **只从给定文本抽取**，prompt 里明写"禁止补充外部知识"——这句是 promptVersion 的一部分
 * - 结构化输出走 `response_format: json_object`（DeepSeek），不解析自由文本
 * - 每条 claim 必须能挂到 span：模型给 quote，我们**逐字符**确认 quote 出现在对应 chunk 里，
 *   确认不了就标 UNVERIFIED（绝不替它编一个引用）
 * - 每批多个 chunk，减少调用次数（材料只有 6000 字符，逐 chunk 调 220 次是浪费）
 */

const SYSTEM_PROMPT = [
  '你是课程材料的概念抽取器。',
  '规则：',
  '1. 只能从【给定文本】里抽取，禁止补充任何外部知识、禁止编造定义。',
  '2. 文本里没有明确讲到的概念，不要输出。',
  '3. 每个概念必须给出一段原文 quote（逐字复制，不要改写、不要加省略号）。',
  '4. 只输出一个 json 对象，形如 {"claims":[{"chunk":0,"name":"...","definition":"...","quote":"..."}]}。',
  '5. 没有可抽取的概念时输出 {"claims":[]}。',
].join('\n')

export const EXTRACT_PROMPT_VERSION = createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 12)

interface ExtractParams {
  /** 每批送多少个 chunk（默认 15） */
  batchSize?: number
  /** 每个 chunk 最多抽多少条，控制成本 */
  maxClaimsPerChunk?: number
}

export interface RawClaim {
  readonly chunk: number
  readonly name: string
  readonly definition: string
  readonly quote: string
}

export const extractExecutor: NodeExecutor<ExtractParams> = {
  type: 'EXTRACT',
  artifactKind: 'CONCEPT_CLAIMS',
  promptVersion: EXTRACT_PROMPT_VERSION,
  inputs: { type: 'object', properties: { chunkSet: { type: 'object' } }, required: ['chunkSet'] },
  outputs: { type: 'object', properties: { conceptClaims: { type: 'object' } }, required: ['conceptClaims'] },

  async run(ctx) {
    const chunkSet = ctx.inputs.chunkSet as ChunkSet | undefined
    if (!chunkSet?.chunks?.length) throw new Error('extract 节点缺少上游 chunkSet')

    const batchSize = ctx.params.batchSize ?? 15
    const maxClaimsPerChunk = ctx.params.maxClaimsPerChunk ?? 3

    const chunks = chunkSet.chunks
    const claims: Array<{
      id: string
      name: string
      definition: string
      spanIds: string[]
      quote: string
      verified: boolean
    }> = []

    let tokensIn = 0
    let tokensOut = 0
    let cachedTokens = 0
    const usageRecords = new Map<string, { provider: string; model: string; tokensIn: number; tokensOut: number; cachedTokens: number }>()

    for (let start = 0; start < chunks.length; start += batchSize) {
      const batch = chunks.slice(start, start + batchSize)
      const userContent = batch
        .map((chunk, index) => `【片段 ${index}】(第 ${chunk.pageStart} 页)\n${chunk.text}`)
        .join('\n\n')

      const result = await ctx.llm.complete({
        taskType: 'extract',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        jsonSchema: {
          type: 'object',
          properties: {
            claims: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  chunk: { type: 'number' },
                  name: { type: 'string' },
                  definition: { type: 'string' },
                  quote: { type: 'string' },
                },
                required: ['chunk', 'name', 'definition', 'quote'],
                additionalProperties: false,
              },
            },
          },
          required: ['claims'],
          additionalProperties: false,
        },
        user: ctx.user,
      })

      tokensIn += result.usage.tokensIn
      tokensOut += result.usage.tokensOut
      cachedTokens += result.usage.cachedTokens

      // 按响应里的真实模型名聚合（DeepSeek 返回的是 deepseek-flash 这类实际版本）
      const key = `deepseek:${result.modelVersion}`
      const record = usageRecords.get(key) ?? {
        provider: 'deepseek',
        model: result.modelVersion,
        tokensIn: 0,
        tokensOut: 0,
        cachedTokens: 0,
      }
      record.tokensIn += result.usage.tokensIn
      record.tokensOut += result.usage.tokensOut
      record.cachedTokens += result.usage.cachedTokens
      usageRecords.set(key, record)

      const data = result.data as { claims?: RawClaim[] }
      const perChunk = new Map<number, number>()

      for (const claim of data.claims ?? []) {
        const chunk = batch[claim.chunk]
        if (!chunk) continue

        const used = perChunk.get(claim.chunk) ?? 0
        if (used >= maxClaimsPerChunk) continue
        perChunk.set(claim.chunk, used + 1)

        const quote = (claim.quote ?? '').trim()
        const name = (claim.name ?? '').trim()
        const definition = (claim.definition ?? '').trim()
        if (!name || !definition) continue

        // 逐字符确认 quote 真的在原文里；确认不了就不是"有出处"
        const verified = quote.length > 0 && chunk.text.includes(quote)

        claims.push({
          id: `claim-${claims.length + 1}`,
          name,
          definition,
          spanIds: verified ? chunk.spanIds : [],
          quote: verified ? quote : '',
          verified,
        })
      }
    }

    const conceptClaims: ConceptClaims = conceptClaimsSchema.parse({
      sourceId: chunkSet.sourceId,
      claims: claims.map((claim) => ({
        id: claim.id,
        name: claim.name,
        definition: claim.definition,
        spanIds: claim.spanIds,
        status: claim.verified ? 'VERIFIED' : 'UNVERIFIED',
      })),
    })

    return {
      outputs: { conceptClaims },
      usage: { tokensIn, tokensOut, cachedTokens },
      usageRecords: [...usageRecords.values()],
    }
  },
}
