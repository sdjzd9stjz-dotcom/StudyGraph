/**
 * 节点类型清单。
 *
 * 与 Prisma schema 里的 `enum NodeType` **必须逐字一致**：
 * test/ports.test.ts 会直接读 schema.prisma 做差集比较，改名或增删都会让测试红。
 */
export const NODE_TYPES = [
  // 第一批 · 知识底座（9）
  'SOURCE',
  'CHUNK',
  'EXTRACT',
  'CARD',
  'PREREQ',
  'QUIZ',
  'GRADE',
  'REVIEW',
  'GATE',
  // 第二批 · 解题方法建模（4）
  'PROBE',
  'METHOD',
  'SOLVE',
  'DIAGNOSE',
  // 第三批 · 出题与组卷（4）
  'VARIANT',
  'DISTRACTOR',
  'CHECK',
  'PAPER',
  // 第四批 · 知识网络（2）
  // DEEPEN 把知识卡与题目收敛成核心观点；LECTURE 把多个节点的问答总结成讲义。
  // 这两类不是「工作流步骤」，而是让画布读起来像一张知识图。
  'DEEPEN',
  'LECTURE',
] as const

export type NodeType = (typeof NODE_TYPES)[number]

/** 实施批次，用来防止"第四批"偷偷出现。 */
export const NODE_BATCH: Readonly<Record<NodeType, 1 | 2 | 3 | 4>> = {
  SOURCE: 1,
  CHUNK: 1,
  EXTRACT: 1,
  CARD: 1,
  PREREQ: 1,
  QUIZ: 1,
  GRADE: 1,
  REVIEW: 1,
  GATE: 1,
  PROBE: 2,
  METHOD: 2,
  SOLVE: 2,
  DIAGNOSE: 2,
  VARIANT: 3,
  DISTRACTOR: 3,
  CHECK: 3,
  PAPER: 3,
  DEEPEN: 4,
  LECTURE: 4,
}

export function isNodeType(value: string): value is NodeType {
  return (NODE_TYPES as readonly string[]).includes(value)
}
