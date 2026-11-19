// 注册表自检：打印已实现 / 未实现 / 并集是否等于 17（SG-SUP-004 §3.3 的证明）
import { PLANNED_PLAN, implementedTypes, selfCheck } from '../apps/api/src/nodes/registry.ts'

const report = selfCheck()

console.log(
  JSON.stringify(
    {
      implemented: report.implemented,
      planned: report.planned,
      plannedCount: report.planned.length,
      implementedCount: report.implemented.length,
      unionSize: report.unionSize,
      ok: report.ok,
      problems: report.problems,
      planByType: PLANNED_PLAN,
      registryEntries: implementedTypes(),
    },
    null,
    2,
  ),
)

process.exit(report.ok ? 0 : 1)
