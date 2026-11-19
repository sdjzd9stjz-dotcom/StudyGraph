import type { TaskType } from './types.ts'

export interface ModelRoute {
  readonly provider: 'openai' | 'anthropic'
  readonly model: string
  readonly tier: 'small' | 'frontier'
}

/**
 * taskType → 模型 的路由表（规格明文要求：切片/抽取/判分走小模型，
 * probe/method/solve/variant 走前沿模型）。
 *
 * 之所以是一张表而不是散在 if 里：换模型这件事必须能一眼看完、一处改动。
 * 模型标识允许用环境变量覆盖，但**代码里必须有一个明确默认值**，
 * 否则"路由到什么"就成了运行时才知道的事。
 */
const SMALL_MODEL = process.env.STUDYGRAPH_SMALL_MODEL ?? 'gpt-4o-mini'
const FRONTIER_MODEL = process.env.STUDYGRAPH_FRONTIER_MODEL ?? 'claude-sonnet-4-5'

export const TASK_ROUTING: Record<TaskType, ModelRoute> = {
  // 机械、量大、便宜的任务
  chunk: { provider: 'openai', model: SMALL_MODEL, tier: 'small' },
  extract: { provider: 'openai', model: SMALL_MODEL, tier: 'small' },
  judge: { provider: 'openai', model: SMALL_MODEL, tier: 'small' },
  check: { provider: 'openai', model: SMALL_MODEL, tier: 'small' },
  quiz: { provider: 'openai', model: SMALL_MODEL, tier: 'small' },
  // 需要推理的任务
  probe: { provider: 'anthropic', model: FRONTIER_MODEL, tier: 'frontier' },
  method: { provider: 'anthropic', model: FRONTIER_MODEL, tier: 'frontier' },
  solve: { provider: 'anthropic', model: FRONTIER_MODEL, tier: 'frontier' },
  variant: { provider: 'anthropic', model: FRONTIER_MODEL, tier: 'frontier' },
}
