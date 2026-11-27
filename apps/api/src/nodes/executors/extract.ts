import { createHash } from 'node:crypto'

import { conceptClaimsSchema } from '../../../../../packages/contracts/src/index.ts'
import type { ChunkSet, ConceptClaims } from '../../../../../packages/contracts/src/index.ts'
import { CLASSIFIER_VERSION, classifyClaim } from '../../spans/claim-support.ts'
import type { ClaimVerdict } from '../../spans/claim-support.ts'
import { composeSystemPrompt, HARD_RULE_SUMMARY } from '../skills.ts'
import type { NodeExecutor } from '../contract.ts'
import { nodeInputMissing } from '../../lib/errors.ts'

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
  '2. 文本里没有明确讲到的概念，不要输出。只有标题、目录或不完整短语时跳过。',
  '目录中的“指导”“指引”等词不能作为定义的依据。',
  '3. quote：必须是原文中【逐字连续】的一句话，不得改写、不得拼接。',
  '4. definition：用你自己的话说明这个概念是什么，必须包含概念名称；不得引入原文之外的信息。',
  '   允许与 quote 措辞不同，但语义必须一致。',
  '   若原文已含概念名称且完整说明其含义，可以直接照录作 definition，保留原标点。其余有明确依据的转述可送人工复核。',
  '   优先提取有实质内容的定义、判据和法则。仅有章节名称、公式名或定理清单时跳过；不为增加数量补写结论。',
  '5. name 必须是原文中出现的名词性术语，不要自己造一个含「的」的描述性短语。',
  '6. definition 必须以 name 的完整字样开头，紧跟谓词再陈述内容，可套用这些句式：',
  '   「<name>是指……」「<name>是……」「<name>表示……」「<name>定义为……」「<name>满足……」。',
  '   不要写成省略主语的句子（如「在其定义域内是连续的」），也不要只写名称本身。',
  '外文课件的 name、definition 和 quote 均使用原文语言，同一语言校验定义和引文。原文确实给出完整定义时优先照录；英文用原文的谓词（如 is、means、denotes），上面的中文句式仅用于中文材料。',
  '7. 只有当原文确实给出了该概念的实质内容时才输出；',
  '   若某个标题下只有名称、没有说明（如「…的注记」「…的适用条件」），跳过它，不要为凑数而输出。',
  '8. 只输出一个 json 对象，形如 {"claims":[{"chunk":0,"name":"...","definition":"...","quote":"..."}]}。',
  '9. 没有可抽取的概念时输出 {"claims":[]}。',
].join('\n')

// 长课件容易跨片段或跨语言误引。各批共用同一组判例，模型仍须逐条引用本批原文。
const EVIDENCE_EXAMPLES = [
  '跨片段核对示例（只解释判定方法，示例内容不能进入输出）：',
  '英文片段若写 “A bridge is an edge whose removal increases the number of connected components.”，name 取原词 bridge；quote 完整照录英文原句，definition 也用英文。若另一页只有 “See the bridge example.”，那一页不能充当定义的出处。',
  '数学片段若写「点属于集合的内部，当且仅当该点存在一个完全包含在该集合中的邻域」，定义要保留「存在」与包含方向。若片段恰好断在「当且仅当」，下一个片段只有公式右端，不要跨片段拼出看似完整的引文。',
  '同一页出现页眉、目录、证明和定义时，逐句核对概念所在的片段编号。不能因为标题包含术语，就借用证明中另一个对象的性质作为这个术语的定义。',
].join('\n')

export const EXTRACT_PROMPT_VERSION = createHash('sha256').update(SYSTEM_PROMPT + '\n' + EVIDENCE_EXAMPLES).digest('hex').slice(0, 12)

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
    if (!chunkSet?.chunks?.length) throw nodeInputMissing('extract 节点缺少上游 chunkSet')

    const batchSize = ctx.params.batchSize ?? 15
    const maxClaimsPerChunk = ctx.params.maxClaimsPerChunk ?? 3

    if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('batchSize 必须是正整数')
    const chunks = chunkSet.chunks
    const claims: Array<{
      id: string
      name: string
      definition: string
      spanIds: string[]
      quote: string
      verdict: ClaimVerdict
      reasons: string[]
      similarity: number
      lengthRatio: number
      spanText: string
    }> = []

    let tokensIn = 0
    let tokensOut = 0
    let cachedTokens = 0
    const usageRecords = new Map<string, { provider: string; model: string; tokensIn: number; tokensOut: number; cachedTokens: number; cacheUsageComplete: boolean }>()

    const basePrompt = composeSystemPrompt(HARD_RULE_SUMMARY, ctx.skills, SYSTEM_PROMPT)
    const examplePrompt = basePrompt + '\n' + EVIDENCE_EXAMPLES
    const canTryExamples = Math.ceil(chunks.length / batchSize) >= 5
    let useExamples = false
    let exampleBatches = 0
    let lowHitBatches = 0
    for (let start = 0; start < chunks.length; start += batchSize) {
      const batch = chunks.slice(start, start + batchSize)
      const userContent = batch
        .map((chunk, index) => `【片段 ${index}】(第 ${chunk.pageStart} 页)\n${chunk.text}`)
        .join('\n\n')

      const result = await ctx.llm.complete({
        taskType: 'extract',
        messages: [
          // F2：硬约束 → skill（按 slug 排序）→ 节点 prompt，顺序固定且进前缀缓存
          { role: 'system', content: useExamples ? examplePrompt : basePrompt },
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
        /**
         * 一批最多 15 个 chunk × 3 条 claim，每条四个字段 —— 2048 的默认额度
         * 写到一半就会被切断（真实事故见 provider-json-recovery.test.ts）。
         * 抽取本来就是"列清单"，按任务给定 8192，别靠翻倍重试兜底多付一次钱。
         */
        maxTokens: 8192,
        user: ctx.user,
      })

      // 先用原提示测一次热缓存。已有命中或缺少用量证据时，保留更短的输入。
      if (canTryExamples && start === batchSize) {
        useExamples = result.usage.cacheUsageComplete !== false && result.usage.cachedTokens === 0
      } else if (useExamples) {
        exampleBatches++
        // 新前缀的首批也可能冷启动。后续连续两批未命中完整前缀时停止试用。
        if (exampleBatches > 1) {
          lowHitBatches = result.usage.cachedTokens >= 1024 ? 0 : lowHitBatches + 1
          if (lowHitBatches >= 2) useExamples = false
        }
      }
      tokensIn += result.usage.tokensIn
      tokensOut += result.usage.tokensOut
      cachedTokens += result.usage.cachedTokens

      // 按响应里的真实模型名聚合（DeepSeek 返回的是 deepseek-flash 这类实际版本）
      const key = `${result.provider}:${result.modelVersion}`
      const record = usageRecords.get(key) ?? {
        provider: result.provider,
        model: result.modelVersion,
        tokensIn: 0,
        tokensOut: 0,
        cachedTokens: 0, cacheUsageComplete: true,
      }
      record.tokensIn += result.usage.tokensIn
      record.tokensOut += result.usage.tokensOut
      record.cacheUsageComplete &&= result.usage.cacheUsageComplete !== false
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

        // 三档判定（SG-SUP-010 §1.3）：extract 与 card 用同一个分类器
        const classification = classifyClaim({ name, definition, quote, spanText: chunk.text })

        claims.push({
          id: `claim-${claims.length + 1}`,
          name,
          definition,
          // 非 UNVERIFIED 必须有引用：A1 通过就是"引文查得到"
          spanIds: classification.verdict === 'UNVERIFIED' ? [] : chunk.spanIds,
          quote,
          verdict: classification.verdict,
          reasons: classification.reasons,
          similarity: classification.similarity,
          lengthRatio: classification.lengthRatio,
          // 判定输入快照（SG-SUP-012 §2.2）：脱离数据库也能重放
          spanText: chunk.text,
        })
      }
    }

    const conceptClaims: ConceptClaims = conceptClaimsSchema.parse({
      sourceId: chunkSet.sourceId,
      promptVersion: EXTRACT_PROMPT_VERSION,
      classifierVersion: CLASSIFIER_VERSION,
      claims: claims.map((claim) => ({
        id: claim.id,
        name: claim.name,
        definition: claim.definition,
        quote: claim.quote,
        spanIds: claim.spanIds,
        status: claim.verdict,
        reasons: claim.reasons,
        // 判定输入快照：quote/definition 之外，还要留住当时的原文与两个相似度指标
        spanText: claim.spanText,
        similarity: claim.similarity,
        lengthRatio: claim.lengthRatio,
        promptVersion: EXTRACT_PROMPT_VERSION,
        classifierVersion: CLASSIFIER_VERSION,
      })),
    })

    return {
      outputs: { conceptClaims },
      usage: { tokensIn, tokensOut, cachedTokens, cacheUsageComplete: [...usageRecords.values()].every(record => record.cacheUsageComplete) },
      usageRecords: [...usageRecords.values()],
    }
  },
}
