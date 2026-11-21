import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { prisma } from '../../../../packages/db/src/index.ts'
import { registerBuiltinExecutors } from '../../src/nodes/executors/index.ts'
import { executeNode } from '../../src/nodes/execute.ts'
import { createObjectStore } from '../../src/storage/object-store.ts'
import type { LLMGateway } from '../../src/llm/types.ts'

/**
 * 节点提示词（`params.prompt`）的**端到端**接线。
 *
 * 单元测试只证明了 `withNodePrompt` 拼得对。真正会坏的是另一件事：
 * `executeNode` 有没有把 `node.params.prompt` 读出来交给执行器。
 * 少了那一行，界面上提示词写得清清楚楚，执行时被静默忽略 ——
 * 学生只会觉得"这 AI 不听我的"，而日志里什么都看不出来。
 *
 * 所以这里用真库 + 桩模型，断言**送进模型的那段系统提示词里真的有这句话**。
 */

interface CapturedRequest {
  readonly messages: ReadonlyArray<{ role: string; content: string }>
}

/** 记下每次请求、返回一份合法的变式产物 */
function capturingGateway(captured: CapturedRequest[]): LLMGateway {
  return {
    routeFor: () => null as never,
    async complete(req: never) {
      captured.push(req as unknown as CapturedRequest)
      return {
        data: {
          variants: [
            { axis: 'magnitude', stem: '求 f(x)=x^3 在 x=2 处的导数', answer: '12', methodNote: '同为求导', difficulty: 2 },
          ],
        },
        usage: { tokensIn: 10, tokensOut: 5, cachedTokens: 0 },
        provider: 'stub',
        modelVersion: 'stub-v1',
      } as never
    },
  } as unknown as LLMGateway
}

// 直接调 executeNode 时要自己注册执行器（正常启动路径由 buildApp 注册）
registerBuiltinExecutors()

const PROMPT = '只考计算题，不要考概念记忆'

async function setup(params: Record<string, unknown>) {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@prompt.invalid`, displayName: 'prompt-tester' },
    select: { id: true },
  })
  const canvas = await prisma.canvas.create({
    data: { ownerId: user.id, title: '提示词接线验收' },
    select: { id: true },
  })
  const node = await prisma.node.create({
    data: { canvasId: canvas.id, type: 'VARIANT', params: params as never, posX: 0, posY: 0 },
    select: { id: true },
  })
  return { user, canvas, node }
}

test('params.prompt 真的进入送进模型的系统提示词', async () => {
  const { user, node } = await setup({ stem: '求 f(x)=x^2 在 x=1 处的导数', count: 1, prompt: PROMPT })
  const captured: CapturedRequest[] = []

  const outcome = await executeNode(
    {
      prisma: prisma as never,
      objectStore: createObjectStore({ localRoot: 'C:/tmp/sg-prompt-objects' }),
      llm: capturingGateway(captured),
      user: { id: user.id } as never,
    },
    node.id,
    { dryRun: false },
  )

  assert.equal(outcome.status, 'SUCCEEDED')
  assert.equal(captured.length, 1, '应该只调一次模型')

  const system = captured[0]!.messages.find((m) => m.role === 'system')
  assert.ok(system, '请求里必须有 system 消息')
  assert.ok(
    system.content.includes(PROMPT),
    `提示词没有进系统提示词：\n${system.content}`,
  )
  // 硬约束必须还在，且排在提示词之前 —— 学生能补充要求但不能推翻溯源
  assert.ok(system.content.includes('没有原文引用的结论不得成为已确认知识'))
  assert.ok(
    system.content.indexOf('没有原文引用的结论不得成为已确认知识') < system.content.indexOf(PROMPT),
    '硬约束必须排在提示词之前',
  )
})

test('没有 prompt 时系统提示词里不出现「节点提示词」这一节', async () => {
  const { user, node } = await setup({ stem: '求 f(x)=x^2 在 x=1 处的导数', count: 1 })
  const captured: CapturedRequest[] = []

  await executeNode(
    {
      prisma: prisma as never,
      objectStore: createObjectStore({ localRoot: 'C:/tmp/sg-prompt-objects' }),
      llm: capturingGateway(captured),
      user: { id: user.id } as never,
    },
    node.id,
    { dryRun: false },
  )

  const system = captured[0]!.messages.find((m) => m.role === 'system')!
  assert.equal(system.content.includes('节点提示词'), false)
})

test('改提示词会让指纹变化（不会命中旧缓存）', async () => {
  const { user, node } = await setup({ stem: '求 f(x)=x^2 在 x=1 处的导数', count: 1, prompt: PROMPT })
  const deps = {
    prisma: prisma as never,
    objectStore: createObjectStore({ localRoot: 'C:/tmp/sg-prompt-objects' }),
    llm: capturingGateway([]),
    user: { id: user.id } as never,
  }

  const first = await executeNode(deps, node.id, { dryRun: false })
  // 第二次同样参数 → 命中缓存
  const second = await executeNode(deps, node.id, { dryRun: false })
  assert.equal(second.status, 'CACHED', '同样的参数应该命中缓存')

  // 改提示词 → 指纹必须变，否则学生改了提示词却拿到旧结果
  await prisma.node.update({
    where: { id: node.id },
    data: { params: { stem: '求 f(x)=x^2 在 x=1 处的导数', count: 1, prompt: `${PROMPT}（换个说法）` } as never },
  })
  const third = await executeNode(deps, node.id, { dryRun: false })
  assert.equal(third.status, 'SUCCEEDED')
  assert.notEqual(third.fingerprint, first.fingerprint)
})
