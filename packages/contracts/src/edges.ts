/**
 * 节点图唯一的三种边语义。
 * 与 Prisma `enum EdgeKind` 逐字一致；test/ports.test.ts 会读 schema 做差集校验。
 *
 * 需要新的关系语义时新增独立关系表（ConceptEdge / MethodEdge 就是两次这么做出来的），
 * **不给这里加第四个值**。
 */
export const EDGE_KINDS = ['DERIVED_FROM', 'PREREQUISITE', 'CITES'] as const

export type EdgeKind = (typeof EDGE_KINDS)[number]

export function isEdgeKind(value: string): value is EdgeKind {
  return (EDGE_KINDS as readonly string[]).includes(value)
}
