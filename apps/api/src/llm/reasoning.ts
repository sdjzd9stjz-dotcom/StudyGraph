import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { reasoningLevels } from '../../../../packages/contracts/src/reasoning.ts'
import { AppError } from '../lib/errors.ts'
import type { TaskType, LLMGateway } from './types.ts'
import type { UserCtx } from './user.ts'

export async function checkEffort(prisma: PrismaClient, provider: string, model: string, effort: string) {
  const row = await prisma.provider.findUnique({ where: { slug: provider }, select: {
    protocol: true, models: { where: { modelId: model }, select: { capabilities: true } },
  } })
  const protocol = row?.protocol ?? (provider === 'anthropic' ? 'ANTHROPIC' : 'OPENAI')
  if (!reasoningLevels(model, protocol, row?.models[0]?.capabilities).includes(effort)) {
    throw new AppError(400, 'MODEL_CAPABILITY_MISMATCH', `${model} 不支持 ${effort}。请重新选择推理强度或恢复模型默认。`)
  }
}

/** 一次操作可以调用模型多轮。先固定模型和档位，后续修改从下一次操作生效。 */
export async function forOperation(llm: LLMGateway, task: TaskType, user: UserCtx, scope: string) {
  return llm.forOperation ? llm.forOperation(task, user, scope) : llm
}
