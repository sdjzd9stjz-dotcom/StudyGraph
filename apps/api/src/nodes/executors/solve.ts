import type { JSONSchema } from '../../llm/types.ts'
import { composeSystemPrompt, HARD_RULE_SUMMARY } from '../skills.ts'
import type { NodeExecutor } from '../contract.ts'
import { nodeInputMissing } from '../../lib/errors.ts'

/**
 * `solve` 执行器（M5）：带 cue 与 why 的分步解法演示。
 *
 * 规格：每步绑定 `conceptId`，**不可跳步**。
 *
 * "不可跳步"是这里的全部价值：答案对但过程省略的教学材料，学生抄完还是不会。
 * 所以这里强制每步给出 cue（看到什么做这一步）与 why（为什么成立），
 * 并且拒绝"由上式可得"这种跳步写法。
 */

const SYSTEM_PROMPT = `你是数学教学助手。给出分步解题过程。

每一步必须包含：
- cue：看到什么线索做这一步（"看到分母有 x，先讨论 x≠0"）
- why：这一步为什么成立（依据哪个定理/性质）
- action：这一步实际做什么
- conceptNames：用到哪个概念

硬性要求：
- **不许跳步**。不许出现"由上式可得""显然""整理得"这类省略中间推理的写法
- 每步只做一件事；一步做完两件事就拆成两步
- 最后给 checks：怎么验证答案对不对`

const outputSchema: JSONSchema = {
  type: 'object',
  properties: {
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
    answer: { type: 'string' },
    checks: { type: 'array', items: { type: 'string' } },
  },
  required: ['steps', 'answer', 'checks'],
  additionalProperties: false,
}

interface SolveParams {
  text: string
}

/** 跳步写法的识别：这些词出现说明中间推理被略过了 */
const SKIP_MARKERS = ['由上式可得', '显然', '易得', '整理得', '综上可得']

export const solveExecutor: NodeExecutor<SolveParams> = {
  type: 'SOLVE',
  artifactKind: 'SOLUTION_TRACE',
  promptVersion: 'solve-v1',
  inputs: { type: 'object', properties: { analysis: { type: 'object' }, method: { type: 'object' } }, required: [] },
  outputs: { type: 'object', properties: { steps: { type: 'array' } }, required: ['steps'] },

  async run(ctx) {
    const text = ctx.params?.text?.trim()
    if (!text) throw nodeInputMissing('solve 节点缺少 params.text（题目原文）')

    const method = ctx.inputs.method as { name?: string; steps?: unknown } | undefined
    const context = method?.name ? `请按方法「${method.name}」解这道题：\n\n${text}` : text

    const result = await ctx.llm.complete({
      taskType: 'solve',
      messages: [
        { role: 'system', content: composeSystemPrompt(HARD_RULE_SUMMARY, ctx.skills, SYSTEM_PROMPT) },
        { role: 'user', content: context },
      ],
      jsonSchema: outputSchema,
      user: ctx.user,
    })

    const data = result.data as {
      steps?: Array<{ cue?: string; why?: string; action?: string; conceptNames?: string[] }>
      answer?: string
      checks?: string[]
    }
    const steps = data.steps ?? []
    if (steps.length === 0) throw new Error('solve 没有返回任何步骤')

    // 跳步检测：给出了 cue/why 却写"显然"，说明模型在敷衍
    const suspicious = steps
      .map((step, index) => ({ index, action: step.action ?? '' }))
      .filter((step) => SKIP_MARKERS.some((marker) => step.action.includes(marker)))

    const concepts = await ctx.prisma.concept.findMany({ where: { canvasId: ctx.canvasId }, select: { id: true, name: true } })
    const byName = new Map(concepts.map((concept) => [concept.name, concept.id]))
    const bound = new Set<string>()
    for (const step of steps) {
      for (const name of step.conceptNames ?? []) {
        const id = byName.get(name)
        if (id) bound.add(id)
      }
    }

    return {
      outputs: {
        steps,
        answer: data.answer ?? '',
        checks: data.checks ?? [],
        // 有跳步嫌疑就报出来 —— 不阻断（可能是合理省略），但必须让人看见
        skipWarnings: suspicious,
        boundConcepts: bound.size,
      },
      usage: result.usage,
      usageRecords: [{ provider: result.provider, model: result.modelVersion, ...result.usage }],
    }
  },
}
