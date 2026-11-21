import { NODE_TYPES, isNodeType } from '../../../../packages/contracts/src/index.ts'
import type { NodeType } from '../../../../packages/contracts/src/index.ts'
import { executorNotImplemented } from '../lib/errors.ts'
import type { NodeExecutor } from './contract.ts'
// 循环导入是有意的：executors/index 只把 registerExecutor 当函数用（函数声明会提升），
// 而自检必须在**任何人**调用时都能看到内置执行器，不能依赖"调用方先注册过"。
import { registerBuiltinExecutors } from './executors/index.ts'

/**
 * 执行器注册表 + 启动自检（SG-SUP-004 §3.3）。
 *
 * 自检的意义不是"17 个都实现了"，而是**不允许半实现悄悄上线**：
 * 已实现的有哪些、没实现的有哪些、调用没实现的会得到什么，三者必须同时可见。
 * 所以未实现的类型不是"缺失"，而是显式 `501 EXECUTOR_NOT_IMPLEMENTED`。
 */
const REGISTRY = new Map<string, NodeExecutor>()

/**
 * **尚未实现**的节点的计划里程碑，用于 501 的 `details.plan`。
 *
 * 已实现（SOURCE、CHUNK）的条目必须从这里删掉：
 * 自检要求 `implemented ∩ planned = ∅`，同类型既"已实现"又"还在计划里"会被判冲突。
 */
/**
 * 尚未实现的节点 → 计划里程碑。
 *
 * **现在是空的**：17 个 NodeType 全部有执行器。
 * 留这个结构是因为自检逻辑（缺计划要报问题、计划表里出现 17 之外的类型要报问题）
 * 仍然要靠它区分"还没做但排了期" 和 "漏了"——把表删掉等于把这两种情况合并。
 */
export const PLANNED_PLAN: Partial<Record<NodeType, string>> = {}

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
  /** 既没实现、也没有计划里程碑的类型（SG-SUP-005 缺陷 C：必须能漏出来） */
  readonly missingPlan: NodeType[]
}

/**
 * 自检必须拿「已实现 ∪ 计划」与 `NODE_TYPES` 的 17 个值做**双向差集**，
 * 而不是检查自己内部一致（SG-SUP-005 缺陷 C / SG-SUP-006 §2）。
 *
 * 三类问题分别检查：
 *   遗漏：NODE_TYPES − (implemented ∪ planned)
 *   多余：(implemented ∪ planned) − NODE_TYPES   ← 曾经先按 NODE_TYPES 过滤键，导致这一支永远查不出
 *   重叠：implemented ∩ planned
 *
 * 关键是**对原始键集合检错，不要先过滤**：过滤之后的集合天然合法，多出来的会被静默吃掉。
 */
export function selfCheck(): SelfCheckReport {
  // 自检必须自己保证"内置执行器已注册"：否则任何人裸导入 registry 调 selfCheck()，
  // 都会看到 4 个已实现的节点被判成"既未实现也没有计划"（SG-SUP-010 复验暴露）。
  registerBuiltinExecutors()
  const implemented = implementedTypes()
  // 原始键，不过滤
  const plannedKeys = Object.keys(PLANNED_PLAN)
  const plannedSet = new Set<string>(plannedKeys)

  const planned = NODE_TYPES.filter((type) => !implemented.includes(type) && plannedSet.has(type))
  const missingPlan = NODE_TYPES.filter((type) => !implemented.includes(type) && !plannedSet.has(type))
  const extraPlanKeys = plannedKeys.filter((key) => !NODE_TYPES.includes(key as NodeType))
  const overlap = implemented.filter((type) => plannedSet.has(type))

  const problems: string[] = []

  for (const type of missingPlan) problems.push(`${type} 既未实现也没有计划里程碑`)

  for (const key of extraPlanKeys) {
    problems.push(`${key} 不是 NODE_TYPES 中的节点类型（可能是拼写错误，或计划表被改坏了）`)
  }

  for (const type of overlap) problems.push(`${type} 同时出现在已实现与计划里`)

  const union = new Set<string>([...implemented, ...planned])
  for (const type of NODE_TYPES) {
    // 已经在 missingPlan 里报过的不要再报一次（同一个缺口说两遍只是噪音）
    if (!union.has(type) && !missingPlan.includes(type)) problems.push(`并集缺少 ${type}`)
  }
  if (implemented.length !== REGISTRY.size) {
    problems.push('注册表里有非 NodeType 的条目')
  }

  return {
    implemented,
    planned,
    unionSize: union.size,
    ok: problems.length === 0,
    problems,
    missingPlan,
  }
}

/**
 * 启动自检：不通过就拒绝启动（SG-SUP-005 缺陷 C）。
 * 半实现的节点表上线后，用户点执行会得到一个"什么都没发生"的节点，比报错更难查。
 */
export function assertRegistryReady(): SelfCheckReport {
  const report = selfCheck()
  if (!report.ok) {
    throw new Error(`执行器注册表自检未通过：\n- ${report.problems.join('\n- ')}`)
  }
  return report
}

/** 取执行器；没有就 501，绝不返回 undefined 让上层静默继续。 */
export function getExecutor(type: string): NodeExecutor {
  const executor = REGISTRY.get(type)
  if (executor) return executor
  const plan = isNodeType(type) ? PLANNED_PLAN[type] : 'M6'
  throw executorNotImplemented(type, plan ?? '未指定')
}

export function hasExecutor(type: string): boolean {
  return REGISTRY.has(type)
}
