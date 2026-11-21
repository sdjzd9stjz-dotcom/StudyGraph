import type { JSONSchema } from '../../llm/types.ts'
import { composeSystemPrompt, HARD_RULE_SUMMARY } from '../skills.ts'
import type { NodeExecutor } from '../contract.ts'

/**
 * `method` 执行器（M5）：解法抽取。
 *
 * 把一个典型案例提炼成可复用的 `Method`：
 *   trigger（看到什么用它）/ conditions（什么时候不能用）/ steps（带 cue 与 why 的步骤链）
 *   / checks（结果自检）/ falterAt（最容易出错的地方）
 *
 * 三个必须成立的约束：
 *   1. 每步必须绑定 conceptId —— 指不出用到哪个概念的步骤是空话
 *   2. `conditions` 不许为空 —— 只讲"什么时候用"不讲"什么时候不能用"的方法是有害的
 *   3. 落库是 UNVERIFIED：方法由模型提炼，不是人间确认过的教学事实
 */

const SYSTEM_PROMPT = `你是数学教学助手。把一道例题提炼成可复用的解题方法。

要求：
- trigger：什么样的题该用这个方法（识别特征，不是"这类题"这种空话）
- conditions：什么情况下这个方法会失效或不适用。**必须给出至少一条**
- steps：分步，每步包含
    cue：看到什么线索做这一步
    why：为什么这一步成立
    conceptIds：这一步用到哪个概念（只填你确实知道的）
- checks：做完之后怎么自检
- falterAt：学生在这一步最容易错在哪`

const outputSchema: JSONSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    summary: { type: 'string' },
    trigger: { type: 'array', items: { type: 'string' } },
    conditions: { type: 'array', items: { type: 'string' } },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cue: { type: 'string' },
          why: { type: 'string' },
          action: { type: 'string' },
          conceptNames: { type: 'array', items: { type: 'string' } },
        },
        required: ['cue', 'why', 'action'],
        additionalProperties: false,
      },
    },
    checks: { type: 'array', items: { type: 'string' } },
    falterAt: { type: 'string' },
  },
  required: ['name', 'trigger', 'conditions', 'steps', 'checks'],
  additionalProperties: false,
}

interface MethodParams {
  /** 典型案例原文 */
  text: string
}

export const methodExecutor: NodeExecutor<MethodParams> = {
  type: 'METHOD',
  artifactKind: 'METHOD_CARD',
  promptVersion: 'method-v1',
  inputs: { type: 'object', properties: { analysis: { type: 'object', description: '上游 probe 结果（可选）' } }, required: [] },
  outputs: { type: 'object', properties: { methodId: { type: 'string' } }, required: ['methodId'] },

  async run(ctx) {
    const text = ctx.params?.text?.trim()
    if (!text) throw new Error('method 节点缺少 params.text（典型案例原文）')

    const analysis = ctx.inputs.analysis as { problemType?: string; concepts?: string[] } | undefined
    const context = analysis
      ? `题型：${analysis.problemType ?? '未知'}\n涉及概念：${(analysis.concepts ?? []).join('、')}\n\n题目：\n${text}`
      : text

    const result = await ctx.llm.complete({
      taskType: 'method',
      messages: [
        { role: 'system', content: composeSystemPrompt(HARD_RULE_SUMMARY, ctx.skills, SYSTEM_PROMPT) },
        { role: 'user', content: context },
      ],
      jsonSchema: outputSchema,
      user: ctx.user,
    })

    const data = result.data as {
      name?: string
      summary?: string
      trigger?: unknown
      conditions?: unknown
      steps?: Array<{ conceptNames?: string[] }>
      checks?: unknown
      falterAt?: string
    }

    if (!data.name || !Array.isArray(data.conditions) || data.conditions.length === 0) {
      // 没有失效边界的方法不能用：它会在不该用的地方被套用
      throw new Error('method 返回缺少名称或 conditions 为空：方法必须有"什么时候不能用"')
    }

    // 概念名 → id；只连本画布已有概念，不凭空造概念
    const concepts = await ctx.prisma.concept.findMany({
      where: { canvasId: ctx.canvasId },
      select: { id: true, name: true },
    })
    const byName = new Map(concepts.map((concept) => [concept.name, concept.id]))
    const stepConceptIds = new Set<string>()
    for (const step of data.steps ?? []) {
      for (const name of step.conceptNames ?? []) {
        const id = byName.get(name)
        if (id) stepConceptIds.add(id)
      }
    }

    const method = await ctx.prisma.method.upsert({
      where: { canvasId_name: { canvasId: ctx.canvasId, name: data.name } },
      create: {
        canvasId: ctx.canvasId,
        name: data.name,
        summary: data.summary ?? null,
        // 模型提炼的方法不是人间确认过的事实
        status: 'UNVERIFIED',
        trigger: (data.trigger ?? []) as object,
        conditions: data.conditions as object,
        steps: (data.steps ?? []) as object,
        checks: (data.checks ?? []) as object,
        falterAt: data.falterAt ?? null,
        createdFromNodeId: ctx.nodeId,
      },
      update: {
        summary: data.summary ?? null,
        trigger: (data.trigger ?? []) as object,
        conditions: data.conditions as object,
        steps: (data.steps ?? []) as object,
        checks: (data.checks ?? []) as object,
        falterAt: data.falterAt ?? null,
        createdFromNodeId: ctx.nodeId,
      },
      select: { id: true, name: true, status: true },
    })

    if (stepConceptIds.size > 0) {
      await ctx.prisma.methodConcept.createMany({
        data: [...stepConceptIds].map((conceptId) => ({ methodId: method.id, conceptId, isCore: true })),
        skipDuplicates: true,
      })
    }

    return {
      outputs: {
        methodId: method.id,
        name: method.name,
        status: method.status,
        stepCount: data.steps?.length ?? 0,
        linkedConcepts: stepConceptIds.size,
      },
      usage: result.usage,
      usageRecords: [{ provider: result.provider, model: result.modelVersion, ...result.usage }],
    }
  },
}
