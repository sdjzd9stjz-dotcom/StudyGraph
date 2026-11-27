/** 同一任务共享画布模型；运行、追问和自动命名各自记住强度。 */
export const NODE_MODEL_TASK = {
  EXTRACT: 'extract', QUIZ: 'quiz', DISTRACTOR: 'quiz', GRADE: 'check', CHECK: 'check',
  PROBE: 'probe', SOLVE: 'solve', VARIANT: 'variant', PREREQ: 'method', METHOD: 'method',
  DIAGNOSE: 'method', DEEPEN: 'method', LECTURE: 'method',
} as const
export function nodeModelTask(type: string) {
  return Object.hasOwn(NODE_MODEL_TASK, type) ? NODE_MODEL_TASK[type as keyof typeof NODE_MODEL_TASK] : undefined
}

const three = ['low', 'medium', 'high']
const four = [...three, 'xhigh']
const five = [...four, 'max']

/** 只接收端点列出的枚举值。空数组同样有意义，表示该端点禁用调节。 */
export function declaredLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.length > 32) return undefined
  const names = value.map(item => typeof item === 'string' ? item : item?.effort)
  if (!names.every((name): name is string => typeof name === 'string' && /^[\w.-]{1,40}$/.test(name))) return undefined
  return [...new Set(names)]
}

interface ModelListing {
  supported_reasoning_levels?: unknown
  supported_reasoning_efforts?: unknown
  reasoning_efforts?: unknown
  effort?: { supported_levels?: unknown }
  capabilities?: { reasoningLevels?: unknown; effort?: Record<string, { supported?: boolean } | boolean> }
}

export function listedReasoningLevels(model: string, listing: ModelListing) {
  const explicit = declaredLevels(listing.supported_reasoning_levels ?? listing.supported_reasoning_efforts ?? listing.reasoning_efforts ?? listing.capabilities?.reasoningLevels)
  if (explicit) return explicit
  const native = declaredLevels(listing.effort?.supported_levels)
  if (native) {
    // DeepSeek 的目录只列启用思考后的档位，关闭思考是另一个原生开关。
    return /^deepseek-(?:flash|v4-(?:flash|pro))$/.test(model) ? [...new Set(['none', ...native])] : native
  }
  const flags = listing.capabilities?.effort
  if (!flags || typeof flags !== 'object') return undefined
  if (flags.supported === false) return []
  const supported = Object.entries(flags).filter(([key, value]) => key !== 'supported' && typeof value === 'object' && value?.supported === true).map(([key]) => key)
  const order = ['none', 'minimal', ...five]
  return declaredLevels([...order.filter(key => supported.includes(key)), ...supported.filter(key => !order.includes(key))])
}

/** 厂商目录优先。内置条目仅匹配已知型号及日期快照，避免把新变体当成旧型号。 */
export function reasoningLevels(model: string, protocol: string, capabilities?: unknown): readonly string[] {
  const advertised = declaredLevels((capabilities as { reasoningLevels?: unknown } | null)?.reasoningLevels)
  if (advertised) return advertised
  const id = model.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '')
  if (protocol === 'ANTHROPIC') {
    if (/^claude-(?:(?:opus|sonnet)-5(?:-5)?|haiku-5-5|opus-4-[78]|(?:mythos|fable)-5(?:-[12])?)$/.test(id)) return five
    if (/^claude-(?:opus|sonnet)-4-6$/.test(id)) return [...three, 'max']
    if (id === 'claude-opus-4-5') return three
    return []
  }
  if (/^deepseek-(?:flash|v4-(?:flash|pro))$/.test(id)) return ['none', 'low', 'high', 'max']
  if (/^gpt-6(?:\.2)?-astra$/.test(id)) return five
  if (/^gpt-5\.(?:2|4|5)$/.test(id)) return ['none', ...four]
  if (id === 'gpt-5.1') return ['none', ...three]
  if (/^gpt-5(?:-mini|-nano)?$/.test(id)) return ['minimal', ...three]
  if (/^(?:o1|o3|o3-mini|o4-mini)$/.test(id)) return three
  if (/^gemini-(?:3-flash|3\.1-flash-lite)(?:-preview)?$/.test(id)) return ['minimal', ...three]
  if (id === 'gemini-3-pro-preview') return ['low', 'high']
  if (id === 'gemini-3.1-pro-preview') return three
  if (/^gemini-4-(?:neon|hydrogen)$/.test(id)) return four
  return []
}
