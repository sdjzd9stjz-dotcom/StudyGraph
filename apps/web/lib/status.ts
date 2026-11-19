/** 节点状态 → 颜色。stale 用琥珀，红色只留给 error（规格明文）。 */
export const STATUS_COLORS: Record<string, string> = {
  DRAFT: '#9ca3af', // 灰：还没跑过
  READY: '#22c55e', // 绿
  STALE: '#f59e0b', // 琥珀：上游变了，等你点执行
  ERROR: '#ef4444', // 红：只用于 error
  RUNNING: '#3b82f6', // 蓝
}

export const STATUS_LABELS: Record<string, string> = {
  DRAFT: '草稿',
  READY: '就绪',
  STALE: '待更新',
  ERROR: '出错',
  RUNNING: '执行中',
}

/** 17 个节点的中文名（与 packages/contracts 的 NodeType 一一对应）。 */
export const NODE_TYPE_LABELS: Record<string, string> = {
  SOURCE: '文件解析',
  CHUNK: '语义切片',
  EXTRACT: '概念抽取',
  CARD: '概念卡',
  PREREQ: '先修推断',
  QUIZ: '出题',
  GRADE: '判分',
  REVIEW: 'FSRS 调度',
  GATE: '人工闸门',
  PROBE: '题型识别',
  METHOD: '解法抽取',
  SOLVE: '分步解法',
  DIAGNOSE: '错因归因',
  VARIANT: '变式生成',
  DISTRACTOR: '干扰项',
  CHECK: '质量闸门',
  PAPER: '组卷',
}
