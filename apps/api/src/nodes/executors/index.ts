import { hasExecutor, registerExecutor } from '../registry.ts'
import { cardExecutor } from './card.ts'
import { chunkExecutor } from './chunk.ts'
import { extractExecutor } from './extract.ts'
import { checkExecutor } from './check.ts'
import { diagnoseExecutor } from './diagnose.ts'
import { distractorExecutor } from './distractor.ts'
import { methodExecutor } from './method.ts'
import { prereqExecutor } from './prereq.ts'
import { probeExecutor } from './probe.ts'
import { paperExecutor } from './paper.ts'
import { solveExecutor } from './solve.ts'
import { variantExecutor } from './variant.ts'
import { sourceExecutor } from './source.ts'
import { gateExecutor } from './gate.ts'
import { gradeExecutor } from './grade.ts'
import { quizExecutor } from './quiz.ts'
import { reviewExecutor } from './review.ts'

/**
 * 内置执行器注册。**这里是"实现了哪些节点"的唯一清单**——
 * 新增执行器只改这一个文件，自检会立刻反映出来。
 *
 * 幂等：重复调用不会因"重复注册"抛错（测试里 buildApp 会被调用多次）。
 */
export function registerBuiltinExecutors(): void {
  for (const executor of [
    sourceExecutor,
    chunkExecutor,
    extractExecutor,
    cardExecutor,
    prereqExecutor,
    quizExecutor,
    gradeExecutor,
    reviewExecutor,
    gateExecutor,
    probeExecutor,
    methodExecutor,
    solveExecutor,
    diagnoseExecutor,
    variantExecutor,
    distractorExecutor,
    checkExecutor,
    paperExecutor,
  ]) {
    if (!hasExecutor(executor.type)) registerExecutor(executor)
  }
}

export {
  sourceExecutor,
  chunkExecutor,
  extractExecutor,
  cardExecutor,
  prereqExecutor,
  quizExecutor,
  gradeExecutor,
  reviewExecutor,
  gateExecutor,
}
