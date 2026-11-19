import type { TaskType } from './types.ts'

export type ProviderId = 'openai' | 'anthropic' | 'deepseek'

export interface ModelRoute {
  readonly provider: ProviderId
  readonly model: string
  readonly tier: 'small' | 'frontier'
}

/**
 * taskType → 模型 的路由表。
 *
 * 规格要求：机械任务走小模型，推理任务走前沿模型。
 *
 * **三家并存（SG-SUP-009 §1，已批准的偏离）**：
 * - OpenAI：机械任务的默认供应商
 * - Anthropic：推理任务（probe/method/solve/variant）
 * - DeepSeek：实调样本供应商，OpenAI 兼容协议；M2 的 `extract` 走它
 *
 * M2 实际用到 `extract`（DeepSeek）；`chunk` 仍是确定性实现、不调模型。
 * `judge/quiz/check` 走 OpenAI，`probe/method/solve/variant` 走 Anthropic——表要完整，
 * 但不要求现在全部实调。
 */
const SMALL_MODEL = process.env.STUDYGRAPH_SMALL_MODEL ?? 'gpt-4o-mini'
const FRONTIER_MODEL = process.env.STUDYGRAPH_FRONTIER_MODEL ?? 'claude-sonnet-4-5'
const DEEPSEEK_CHAT = process.env.STUDYGRAPH_DEEPSEEK_MODEL ?? 'deepseek-chat'
const DEEPSEEK_REASONER = process.env.STUDYGRAPH_DEEPSEEK_REASONER ?? 'deepseek-reasoner'

export const TASK_ROUTING: Record<TaskType, ModelRoute> = {
  // 机械、量大、便宜的任务
  chunk: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small' },
  extract: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small' },
  judge: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small' },
  quiz: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small' },
  check: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small' },
  // 需要推理的任务
  probe: { provider: 'deepseek', model: DEEPSEEK_REASONER, tier: 'frontier' },
  method: { provider: 'deepseek', model: DEEPSEEK_REASONER, tier: 'frontier' },
  solve: { provider: 'deepseek', model: DEEPSEEK_REASONER, tier: 'frontier' },
  variant: { provider: 'deepseek', model: DEEPSEEK_REASONER, tier: 'frontier' },
}

/**
 * 保留 OpenAI / Anthropic 两条显式路由，供以后按成本切换：
 * 改 `routing` 参数即可，不需要动 Gateway 代码。
 */
export const OPENAI_SMALL_ROUTE: ModelRoute = { provider: 'openai', model: SMALL_MODEL, tier: 'small' }
export const ANTHROPIC_FRONTIER_ROUTE: ModelRoute = {
  provider: 'anthropic',
  model: FRONTIER_MODEL,
  tier: 'frontier',
}
