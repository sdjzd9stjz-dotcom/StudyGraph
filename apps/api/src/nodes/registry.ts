import { NODE_TYPES, isNodeType } from '../../../../packages/contracts/src/index.ts'
import type { NodeType } from '../../../../packages/contracts/src/index.ts'
import { executorNotImplemented } from '../lib/errors.ts'
import type { NodeExecutor } from './contract.ts'

/**
 * 执行器注册表 + 启动自检（SG-SUP-004 §3.3）。
 *
 * 自检的意义不是"17 个都实现了"，而是**不允许半实现悄悄上线**：
 * 已实现的有哪些、没实现的有哪些、调用没实现的会得到什么，三者必须同时可见。
 * 所以未实现的类型不是"缺失"，而是显式 `501 EXECUTOR_NOT_IMPLEMENTED`。
 */
const REGISTRY = new Map<string, NodeExecutor>()

/** 每个未实现节点的计划里程碑，用于 501 的 details.plan。 */
export const PLANNED_PLAN: Record<NodeType, string> = {
  SOURCE: 'M2',
  CHUNK: 'M2',
  EXTRACT: 'M2',
  CARD: 'M2',
  PREREQ: 'M3',
  QUIZ: 'M3',
  GRADE: 'M3',
  REVIEW: 'M3',
  GATE: 'M5',
  PROBE: 'M5',
  METHOD: 'M5',
  SOLVE: 'M5',
  DIAGNOSE: 'M5',
  VARIANT: 'M6',
  DISTRACTOR: 'M6',
  CHECK: 'M6',
  PAPER: 'M6',
}

export function registerExecutor(executor: NodeExecutor): void {
  if (!isNodeType(executor.type)) {
    throw new Error(`registerExecutor: ${executor.type} 不在 17 个 NodeType 之内`)
  }
  if (REGISTRY.has(executor.type)) {
    throw new Error(`registerExecutor: ${executor.type} 重复注册`)
  }
  REGISTRY.set(executor.type, executor)
}

export function implementedTypes(): NodeType[] {
  return [...REGISTRY.keys()].filter(isNodeType)
}

export interface SelfCheckReport {
  readonly implemented: NodeType[]
  readonly planned: NodeType[]
  /** 已实现 ∪ 计划 的并集大小，必须等于 17 */
  readonly unionSize: number
  readonly ok: boolean
  readonly problems: string[]
}

export function selfCheck(): SelfCheckReport {
  const implemented = implementedTypes()
  const planned = NODE_TYPES.filter((type) => !implemented.includes(type))
  const union = new Set<NodeType>([...implemented, ...planned])
  const problems: string[] = []

  if (union.size !== NODE_TYPES.length) {
    problems.push(`已实现 ∪ 计划 = ${union.size}，应为 ${NODE_TYPES.length}`)
  }
  if (implemented.length !== REGISTRY.size) {
    problems.push('注册表里有非 NodeType 的条目')
  }
  for (const type of implemented) {
    if (!(type in PLANNED_PLAN)) problems.push(`${type} 没有计划里程碑`)
  }

  return {
    implemented,
    planned,
    unionSize: union.size,
    ok: problems.length === 0,
    problems,
  }
}

/** 取执行器；没有就 501，绝不返回 undefined 让上层静默继续。 */
export function getExecutor(type: string): NodeExecutor {
  const executor = REGISTRY.get(type)
  if (executor) return executor
  const plan = isNodeType(type) ? PLANNED_PLAN[type] : 'M6'
  throw executorNotImplemented(type, plan)
}

export function hasExecutor(type: string): boolean {
  return REGISTRY.has(type)
}
