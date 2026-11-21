import type { NodeExecutor } from '../contract.ts'
import { ZERO_USAGE } from '../contract.ts'

/**
 * `paper` 执行器（M6）：按规格组卷。
 *
 * **不调模型**，纯确定性算法。理由：组卷是"从已有题库里挑题、排序、配分"，
 * 这件事用规则做比模型可靠得多 —— 模型会漏题、会重复、会给出凑不够的卷子还假装凑够了。
 *
 * 规格原文：`report` 里「覆盖不足必须明说，禁止静默补齐」。
 * 这条是整个执行器的核心：凑不够就说凑不够，绝不拿一道不合格的题凑数。
 */

export interface PaperSpec {
  /** 必须具备的知识点（按 coverage 要求每个至少 x 道） */
  concepts?: string[]
  /** 总时长（分钟），用于估算题量 */
  durationMin?: number
  /** 难度分布：{ "1": 2, "2": 3, ... } */
  difficultyWeights?: Record<string, number>
  /** 题型分布 */
  types?: string[]
  /** 每题配分 */
  pointsPerProblem?: number
}

interface PaperParams extends PaperSpec {
  /** 卷子标题 */
  title?: string
}

export const paperExecutor: NodeExecutor<PaperParams> = {
  type: 'PAPER',
  artifactKind: 'PAPER',
  promptVersion: 'no-prompt',
  inputs: {
    type: 'object',
    properties: { problems: { type: 'array', description: '上游题目集合（可选，缺省则用画布已确认的题）' } },
    required: [],
  },
  outputs: {
    type: 'object',
    properties: { paperId: { type: 'string' }, report: { type: 'object' } },
    required: ['paperId', 'report'],
  },

  async run(ctx) {
    const spec: PaperSpec = {
      concepts: ctx.params.concepts ?? [],
      durationMin: ctx.params.durationMin ?? 60,
      difficultyWeights: ctx.params.difficultyWeights ?? {},
      types: ctx.params.types ?? [],
      pointsPerProblem: ctx.params.pointsPerProblem ?? 1,
    }

    // 只从**已通过三检**的题里挑：REJECTED / PENDING 的题不该进卷子
    const candidates = await ctx.prisma.problem.findMany({
      where: { canvasId: ctx.canvasId, status: { in: ['VERIFIED', 'PENDING'] } },
      orderBy: [{ difficulty: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        type: true,
        difficulty: true,
        concepts: { select: { conceptId: true } },
      },
    })

    // 按规格过滤：题型、知识点
    const filtered = candidates.filter((problem) => {
      if (spec.types && spec.types.length > 0 && !spec.types.includes(problem.type)) return false
      return true
    })

    /**
     * 难度分布：把目标比例转成每档要几道。
     * 分钟数按 5 分钟/题估算（这是保守值，宁可少而精）。
     */
    const targetCount = Math.max(1, Math.floor((spec.durationMin ?? 60) / 5))
    const weights = spec.difficultyWeights ?? {}
    const weightTotal = Object.values(weights).reduce((sum, weight) => sum + weight, 0)

    const picked: typeof filtered = []
    const gaps: Array<{ what: string; wanted: number; got: number }> = []

    if (weightTotal > 0) {
      for (const [difficultyText, weight] of Object.entries(weights)) {
        const difficulty = Number(difficultyText)
        const want = Math.round((weight / weightTotal) * targetCount)
        const pool = filtered.filter((problem) => problem.difficulty === difficulty && !picked.includes(problem))
        const take = pool.slice(0, want)
        picked.push(...take)
        if (take.length < want) gaps.push({ what: `难度 ${difficulty}`, wanted: want, got: take.length })
      }
    } else {
      const take = filtered.slice(0, targetCount)
      picked.push(...take)
      if (take.length < targetCount) gaps.push({ what: '总题量', wanted: targetCount, got: take.length })
    }

    // 知识点覆盖：每个要求的知识点至少要有一道题，缺了就明说
    for (const conceptId of spec.concepts ?? []) {
      const count = picked.filter((problem) => problem.concepts.some((link) => link.conceptId === conceptId)).length
      if (count === 0) gaps.push({ what: `知识点 ${conceptId}`, wanted: 1, got: 0 })
    }

    const report = {
      requested: { targetCount, durationMin: spec.durationMin ?? 60 },
      // 覆盖不足必须明说，禁止静默补齐
      gaps,
      complete: gaps.length === 0,
      pickedCount: picked.length,
    }

    // 一道都没挑到时也要落一条记录：让用户看到"为什么出不来"，而不是报个空对象
    const paper = await ctx.prisma.paper.create({
      data: {
        canvasId: ctx.canvasId,
        title: ctx.params.title ?? `组卷 ${new Date().toLocaleDateString('zh-CN')}`,
        spec: spec as object,
        report: report as object,
        durationMin: spec.durationMin ?? 60,
        status: picked.length > 0 ? 'DRAFT' : 'DRAFT',
        items: {
          create: picked.map((problem, index) => ({
            problemId: problem.id,
            order: index + 1,
            points: spec.pointsPerProblem ?? 1,
          })),
        },
      },
      select: { id: true, title: true },
    })

    return {
      outputs: { paperId: paper.id, title: paper.title, report },
      usage: ZERO_USAGE,
    }
  },
}
