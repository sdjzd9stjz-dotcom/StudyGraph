import assert from 'node:assert/strict'
import test from 'node:test'

import { quizExecutor } from '../../src/nodes/executors/quiz.ts'

/**
 * 出题执行器的题型约束（端到端，假模型）。
 *
 * 上一层测试只验"能不能从提示词里读出题型"；这里验**读出来之后真的会执行**：
 * 模型返回计算题、用户要的是证明题 → 这道题必须被丢掉，而不是照收。
 *
 * 真实反馈就是卡在这里：界面上写着"只要证明题"，出来的全是计算题。
 */

const concept = {
  id: 'c1',
  name: '线性空间的维数',
  definition: '向量空间的一组基所含向量的个数称为该空间的维数。',
  citations: [{ spanId: 'span-1' }],
}

function makeCtx(params: Record<string, unknown>, problems: unknown) {
  const created: Array<Record<string, unknown>> = []
  const requests: any[] = []
  const ctx = {
    params,
    inputs: {},
    skills: [],
    canvasId: 'canvas-1',
    nodeId: 'node-1',
    user: { id: 'u1', email: 'u@t.t', displayName: 'u' },
    objectStore: {},
    spans: {},
    prisma: {
      concept: { findMany: async () => [concept] },
      problem: {
        create: async ({ data }: any) => {
          created.push(data)
          return { id: `p${created.length}`, type: data.type, stemMd: data.stemMd, difficulty: data.difficulty, status: data.status }
        },
      },
    },
    llm: {
      complete: async (request: any) => {
        requests.push(request)
        return { data: { problems }, usage: { tokensIn: 1, tokensOut: 1, cachedTokens: 0 }, modelVersion: 'm', provider: 'deepseek' }
      },
    },
  }
  return { ctx: ctx as never, created, requests }
}

const computation = {
  type: 'COMPUTATION',
  stem: '矩阵 A 有 7 列，且 r(A)=4，求 N(A) 的基础解系应含多少个向量？',
  answer: '3',
  judgeRule: 'EXACT',
  conceptNames: ['线性空间的维数'],
}

const proof = {
  type: 'PROOF',
  stem: '证明：若 dim V = n，则 V 中任意 n+1 个向量必线性相关。',
  answer: '设 v1…v(n+1) 线性无关，则它们是某个子空间的基\n该子空间维数大于 n，与 dim V = n 矛盾',
  judgeRule: 'EXACT',
  conceptNames: ['线性空间的维数'],
}

test('提示词要求证明题 → 计算题被丢弃，证明题保留', async () => {
  const { ctx, created, requests } = makeCtx(
    { count: 2, prompt: '要求是证明题，可涉及到线性空间的综合考察' },
    [computation, proof],
  )

  const result = await quizExecutor.run(ctx)

  assert.equal(created.length, 1, '只应留下证明题')
  assert.equal(created[0]!.type, 'PROOF')
  assert.equal(result.outputs.actual, 1)
  assert.equal(result.outputs.requested, 2)

  // 缺口要能解释
  const dropped = result.outputs.dropped as Array<{ reason: string }>
  assert.ok(dropped.some((item) => /题型 COMPUTATION 不在限定范围/.test(item.reason)))

  // 请求里必须真的把约束写给模型
  const [material, instruction] = requests[0].messages.filter((m: any) => m.role === 'user')
  assert.match(material.content, /线性空间的维数/)
  assert.match(instruction.content, /出 2 道题/)
  assert.match(instruction.content, /只允许 PROOF/)
})

test('参数栏限定题型时，同样会丢弃其它题型', async () => {
  const { ctx, created } = makeCtx({ count: 2, types: ['PROOF'] }, [computation, proof])
  await quizExecutor.run(ctx)
  assert.deepEqual(created.map((item) => item.type), ['PROOF'])
})

test('证明题即使模型给了 EXACT，也会被改成 RUBRIC 并生成要点', async () => {
  const { ctx, created } = makeCtx({ count: 1, prompt: '证明题' }, [proof])
  await quizExecutor.run(ctx)

  assert.equal(created[0]!.judgeRule, 'RUBRIC', '证明题不能用字符串全等判分')
  const spec = created[0]!.judgeSpec as { points?: string[] }
  assert.ok(Array.isArray(spec.points) && spec.points.length >= 2, '要点应从答案里拆出来')
})

test('没有题型要求时不做限制（不能因为保守把题全丢了）', async () => {
  const { ctx, created } = makeCtx({ count: 2 }, [computation, proof])
  await quizExecutor.run(ctx)
  assert.equal(created.length, 2)
})
