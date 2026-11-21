import type { NodeType } from '../../../packages/contracts/src/client'

/**
 * 画布上「首屏可见」的节点集（用户要求：新手也能直接上手）。
 *
 * 17 个类型全摆出来会让新用户无从下手，所以侧栏默认只显示这 6 个 ——
 * 它们拼起来是一条**真正能跑通**的知识链，每个都对应一句人话。
 * 其余节点收进侧栏底部的「高级」折叠区，不删除（规格要求 17 个都在）。
 */
export const PRIMARY_NODES: Array<{
  type: NodeType
  label: string
  hint: string
  color: string
}> = [
  { type: 'SOURCE', label: '课件', hint: '上传 PPTX 或 PDF', color: '#0ea5e9' },
  { type: 'CHUNK', label: '切片', hint: '按语义把长文切开', color: '#8b5cf6' },
  { type: 'EXTRACT', label: '概念', hint: '从原文里抽出知识点', color: '#f59e0b' },
  { type: 'CARD', label: '知识卡', hint: '每条概念一张可溯源的卡', color: '#10b981' },
  { type: 'PREREQ', label: '先修', hint: '推断知识之间的先后关系', color: '#ec4899' },
  { type: 'REVIEW', label: '复习', hint: '按记忆强度安排复习', color: '#6366f1' },
  // 第四批：让画布成为知识网络（而非工作流）
  { type: 'DEEPEN', label: '深入理解', hint: '从知识卡与题目里提炼核心观点', color: '#d946ef' },
  { type: 'LECTURE', label: '导出讲义', hint: '汇总多个节点的问答，生成 PDF 讲义', color: '#0f766e' },
]

export const PRIMARY_TYPES = new Set<NodeType>(PRIMARY_NODES.map((node) => node.type))

export const ADVANCED_NODES: Array<{ type: NodeType; label: string; hint: string }> = [
  { type: 'QUIZ', label: '出题', hint: '生成练习题' },
  { type: 'GRADE', label: '判分', hint: '自动判分' },
  { type: 'GATE', label: '人工闸门', hint: '人工确认后再继续' },
  { type: 'PROBE', label: '题型识别', hint: '判断题目考什么' },
  { type: 'METHOD', label: '解法抽取', hint: '把例题提炼成方法' },
  { type: 'SOLVE', label: '分步解法', hint: '带提示与理由的步骤链' },
  { type: 'DIAGNOSE', label: '错因归因', hint: '分析为什么错' },
  { type: 'VARIANT', label: '变式', hint: '沿维度生成变式题' },
  { type: 'DISTRACTOR', label: '干扰项', hint: '生成有诊断性的错误选项' },
  { type: 'CHECK', label: '质量闸门', hint: '出题后三检' },
  { type: 'PAPER', label: '组卷', hint: '按规则拼成一张卷' },
]

export const nodeColor = (type: string): string =>
  PRIMARY_NODES.find((node) => node.type === type)?.color ?? '#94a3b8'

export const nodeHint = (type: string): string =>
  [...PRIMARY_NODES, ...ADVANCED_NODES].find((node) => node.type === type)?.hint ?? ''

/** 友好的节点名：新手看到的应该是「课件」而不是「文件解析」 */
export const nodeLabel = (type: string): string =>
  [...PRIMARY_NODES, ...ADVANCED_NODES].find((node) => node.type === type)?.label ?? type

// ── 节点参数表单 ────────────────────────────────────────────────────────────
/**
 * 每个节点要填哪些参数。
 *
 * 为什么需要这张表：有六个节点（题型识别、解法抽取、分步解法、变式、干扰项、
 * 质量闸门）处理的是**某一道具体的题**，题目原文没法从上游自动获得 ——
 * 不给填参数的地方，这六个节点在界面上就是死的，一运行就报"缺少 params.text"。
 *
 * 字段类型：
 *   text/textarea  字符串
 *   number         数字（空字符串视为不填，不写进 params）
 *   csv            逗号分隔 → string[]
 */
export type ParamFieldType = 'text' | 'textarea' | 'number' | 'csv' | 'bool'

export interface ParamField {
  readonly key: string
  readonly label: string
  readonly type: ParamFieldType
  readonly placeholder?: string
}

export const NODE_PARAM_FIELDS: Partial<Record<NodeType, ParamField[]>> = {
  CHUNK: [{ key: 'maxChars', label: '每片目标字数', type: 'number', placeholder: '留空按页切' }],
  EXTRACT: [
    { key: 'batchSize', label: '每批段数', type: 'number', placeholder: '默认 15' },
    { key: 'maxClaimsPerChunk', label: '每段最多几条', type: 'number', placeholder: '留空不限制' },
  ],
  REVIEW: [
    { key: 'limit', label: '一次排几张', type: 'number', placeholder: '默认 20' },
    { key: 'includeNew', label: '带上没复习过的新卡', type: 'bool' },
  ],
  QUIZ: [
    { key: 'count', label: '出几道', type: 'number', placeholder: '默认 5' },
    { key: 'difficulty', label: '难度 1–5', type: 'number', placeholder: '留空由模型判断' },
    { key: 'types', label: '限定题型', type: 'csv', placeholder: 'SINGLE_CHOICE, FILL_BLANK' },
  ],
  LECTURE: [{ key: 'title', label: '讲义标题', type: 'text', placeholder: '留空由模型拟定' }],
  PROBE: [{ key: 'text', label: '题目原文', type: 'textarea', placeholder: '把这道题的题干粘进来' }],
  METHOD: [{ key: 'text', label: '例题原文', type: 'textarea', placeholder: '例题题干与解法' }],
  SOLVE: [{ key: 'text', label: '题目原文', type: 'textarea', placeholder: '要分步讲解的题' }],
  DIAGNOSE: [
    { key: 'answer', label: '你的作答', type: 'textarea', placeholder: '把写下的答案粘进来' },
    { key: 'problemText', label: '题目原文', type: 'textarea', placeholder: '可选，给了定位更准' },
  ],
  VARIANT: [
    { key: 'stem', label: '原题题干', type: 'textarea', placeholder: '变式会保留它的方法结构' },
    { key: 'count', label: '出几道', type: 'number', placeholder: '默认按维度数' },
  ],
  DISTRACTOR: [
    { key: 'stem', label: '题干', type: 'textarea' },
    { key: 'answer', label: '正确答案', type: 'text' },
    { key: 'count', label: '几个干扰项', type: 'number', placeholder: '默认 3' },
  ],
  CHECK: [
    { key: 'stem', label: '题干', type: 'textarea' },
    { key: 'answer', label: '给定答案', type: 'text' },
  ],
  PAPER: [
    { key: 'title', label: '卷子标题', type: 'text', placeholder: '留空用默认标题' },
    { key: 'durationMin', label: '时长（分钟）', type: 'number', placeholder: '默认 60' },
    { key: 'types', label: '限定题型', type: 'csv', placeholder: 'SINGLE_CHOICE, COMPUTATION' },
  ],
  GRADE: [
    {
      key: 'items',
      label: '要批的作答（JSON）',
      type: 'textarea',
      placeholder: '[{"problemId":"…","answer":"A"}]',
    },
  ],
}

export const paramFieldsFor = (type: string): ParamField[] =>
  NODE_PARAM_FIELDS[type as NodeType] ?? []

/**
 * 每个节点都能填的「提示词」。
 *
 * 它会作为**附加说明**拼进系统提示词，位置在所有硬约束和技能之后 ——
 * 也就是说：学生可以补充要求，但不能推翻溯源、不能推翻"不许编造出处"这类硬约束。
 * 之所以不做成"完全自定义提示词"：那等于让执行器的全部安全规则可被覆盖。
 */
export const PROMPT_FIELD: ParamField = {
  key: 'prompt',
  label: '提示词（你希望它怎么做）',
  type: 'textarea',
  placeholder: '例如：只考计算题，不要考概念记忆',
}
