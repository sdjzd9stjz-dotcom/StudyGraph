import type { TaskType } from './types.ts'

/**
 * 厂商标识。**是开放的字符串**：多供应商之后，供应商来自数据表（含学生自建的
 * custom-xxx），不可能再穷举成字面量联合类型。预置值：openai | deepseek | anthropic | …
 */
export type ProviderId = string

export interface ModelRoute {
  readonly provider: ProviderId
  readonly model: string
  readonly expectedVersion?: string
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
/**
 * DeepSeek 的模型名以官方 `/models` 返回为准：现在是 `deepseek-flash` 与 `deepseek-v4-pro`。
 *
 * 之前默认值写的是 `deepseek-chat` / `deepseek-reasoner` —— 这两个名字已经不存在了，
 * 于是默认路由下每一个调模型的任务都会失败（而且报错来自厂商，看起来像"服务器错误"）。
 * 换模型只需要改这两个环境变量，不用动代码。
 */
const DEEPSEEK_CHAT = process.env.STUDYGRAPH_DEEPSEEK_MODEL ?? 'deepseek-flash'
const DEEPSEEK_REASONER = process.env.STUDYGRAPH_DEEPSEEK_REASONER ?? 'deepseek-v4-pro'

export const TASK_ROUTING: Record<TaskType, ModelRoute> = {
  // 机械、量大、便宜的任务
  chunk: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small' },
  extract: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small', ...(process.env.STUDYGRAPH_EXTRACT_MODEL_VERSION ? { expectedVersion: process.env.STUDYGRAPH_EXTRACT_MODEL_VERSION } : {}) },
  judge: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small' },
  quiz: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small' },
  check: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small' },
  // 需要推理的任务
  probe: { provider: 'deepseek', model: DEEPSEEK_REASONER, tier: 'frontier' },
  method: { provider: 'deepseek', model: DEEPSEEK_REASONER, tier: 'frontier' },
  solve: { provider: 'deepseek', model: DEEPSEEK_REASONER, tier: 'frontier' },
  variant: { provider: 'deepseek', model: DEEPSEEK_REASONER, tier: 'frontier' },
  /**
   * 底部对话栏：要读画布内容、还要调工具改画布，属于推理型任务。
   * 在「模型供应商 → 按任务指定模型」里可以单独把它换成更便宜/更快的模型。
   */
  assistant: { provider: 'deepseek', model: DEEPSEEK_REASONER, tier: 'frontier' },
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
