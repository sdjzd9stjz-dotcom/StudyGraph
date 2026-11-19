import { hasExecutor, registerExecutor } from '../registry.ts'
import { chunkExecutor } from './chunk.ts'
import { sourceExecutor } from './source.ts'

/**
 * 内置执行器注册。**这里是"实现了哪些节点"的唯一清单**——
 * 新增执行器只改这一个文件，自检会立刻反映出来。
 *
 * 幂等：重复调用不会因"重复注册"抛错（测试里 buildApp 会被调用多次）。
 */
export function registerBuiltinExecutors(): void {
  for (const executor of [sourceExecutor, chunkExecutor]) {
    if (!hasExecutor(executor.type)) registerExecutor(executor)
  }
}

export { sourceExecutor, chunkExecutor }
