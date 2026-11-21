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
