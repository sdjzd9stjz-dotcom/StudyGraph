/**
 * 任务类型 → 必需能力。
 *
 * 为什么放在 contracts 而不是某个路由里：全局配置（/v1/preferences）和
 * 画布配置（/v1/canvases/:id/model-prefs）必须**用同一套规则**校验。
 * 复制两份的结果是"全局会拒绝的模型，在画布里能存进去"，然后运行到一半才失败。
 *
 * `null` = 这个任务不要求特定能力（对话要的是工具调用，不该拿 JSON 能力卡它）。
 */
export const REQUIRED_CAPABILITY: Readonly<Record<string, 'jsonObject' | null>> = {
  extract: 'jsonObject',
  judge: 'jsonObject',
  quiz: 'jsonObject',
  check: 'jsonObject',
  variant: 'jsonObject',
  chunk: null,
  probe: null,
  method: null,
  solve: null,
  // 底部对话要的是工具调用能力，不是 JSON 输出能力
  assistant: null,
}

export const TASK_TYPE_KEYS = Object.keys(REQUIRED_CAPABILITY)

/** 任务类型的中文名：全局配置页与画布配置页共用，避免两处措辞不一致 */
export const TASK_LABELS: Readonly<Record<string, string>> = {
  assistant: '底部对话',
  extract: '概念抽取',
  chunk: '切片',
  quiz: '出题',
  judge: '判题',
  check: '三检',
  variant: '变式',
  probe: '题型识别',
  method: '方法 / 深入理解 / 讲义',
  solve: '分步解法',
}

export function isTaskType(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(REQUIRED_CAPABILITY, value)
}
