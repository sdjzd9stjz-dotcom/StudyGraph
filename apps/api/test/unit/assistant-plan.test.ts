import assert from 'node:assert/strict'
import test from 'node:test'

import { actionsFromModelPlan, looksLikeQuestion } from '../../src/routes/assistant.ts'

/**
 * 模型规划 → 画布动作。
 *
 * 这段逻辑坏掉时的表现是"模型说了，画布没变" —— 和"模型根本没被调用"
 * 在界面上完全一样，所以只能在这里测。
 */

test('只接受 17 个真实节点类型，模型编的名字直接丢掉', () => {
  const actions = actionsFromModelPlan(
    { nodes: [{ type: 'NOT_A_NODE' }, { type: 'QUIZ' }, { type: 123 as unknown as string }] },
    [],
  )
  const created = actions.filter((action) => action.kind === 'create-node')
  assert.equal(created.length, 1)
  assert.equal((created[0]!.payload as { type: string }).type, 'QUIZ')
})

test('画布上已有的类型不重复创建，但连线仍允许连到它', () => {
  const actions = actionsFromModelPlan(
    { nodes: [{ type: 'CARD' }, { type: 'QUIZ' }], edges: [{ from: 'CARD', to: 'QUIZ' }] },
    ['CARD'],
  )
  const created = actions.filter((action) => action.kind === 'create-node')
  assert.deepEqual(created.map((action) => (action.payload as { type: string }).type), ['QUIZ'])

  const edges = actions.filter((action) => action.kind === 'create-edge')
  assert.equal(edges.length, 1, '连到已有节点的线必须保留，否则多轮追加会断图')
})

test('断头线与自连一律丢弃', () => {
  const actions = actionsFromModelPlan(
    {
      nodes: [{ type: 'QUIZ' }],
      edges: [
        { from: 'QUIZ', to: 'QUIZ' }, // 自连
        { from: 'QUIZ', to: 'PAPER' }, // PAPER 既没建也不存在
        { from: 'GHOST', to: 'QUIZ' }, // 上游不存在
      ],
    },
    [],
  )
  assert.equal(actions.filter((action) => action.kind === 'create-edge').length, 0)
})

test('给模型规划出来的节点分配位置，不会全叠在原点', () => {
  const actions = actionsFromModelPlan({ nodes: [{ type: 'QUIZ' }, { type: 'GATE' }] }, [])
  const positions = actions.map((action) => (action.payload as { pos?: { x: number; y: number } }).pos)
  assert.ok(positions.every(Boolean), '每个新建节点都要带坐标')
  assert.notDeepEqual(positions[0], positions[1])
})

test('空规划返回空动作（交由规则兜底，而不是先建一堆无关节点）', () => {
  assert.deepEqual(actionsFromModelPlan(undefined, []), [])
  assert.deepEqual(actionsFromModelPlan({ nodes: [], edges: [] }, ['CARD']), [])
})

test('问句与建图指令分开：问句不会被当成"帮我建节点"', () => {
  // 建图指令
  assert.equal(looksLikeQuestion('把课件做成知识卡'), false)
  assert.equal(looksLikeQuestion('再加一条解题支线'), false)
  assert.equal(looksLikeQuestion('我要完整的图'), false)
  // 提问
  assert.equal(looksLikeQuestion('组卷节点里现在有几道题？'), true)
  assert.equal(looksLikeQuestion('为什么这一步成立?'), true)
  assert.equal(looksLikeQuestion('解释一下导数的定义'), true)
})

test('模型用 label / note / source+target 命名时照样能落地（DeepSeek 实际就这么写）', () => {
  // 2026-11-21 实测 deepseek-flash 的输出形态：nodes 用 label，edges 用 source/target
  const actions = actionsFromModelPlan(
    {
      nodes: [
        { type: 'SOURCE', label: '课件原件' } as never,
        { type: 'CHUNK', label: '按章节切分' } as never,
      ],
      edges: [{ source: 'SOURCE', target: 'CHUNK' } as never],
    },
    [],
  )

  const created = actions.filter((action) => action.kind === 'create-node')
  assert.equal(created.length, 2)
  assert.equal((created[0]!.payload as { title: string }).title, '课件原件', 'label 要当标题用，否则卡片标题全是类型名')

  // 连线的别名不认，整张图就只剩孤立节点 —— 界面上看不出是哪一步丢的
  const edges = actions.filter((action) => action.kind === 'create-edge')
  assert.deepEqual(edges.map((edge) => edge.payload), [{ from: 'SOURCE', to: 'CHUNK' }])
})
