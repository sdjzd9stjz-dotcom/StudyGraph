import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { EDGE_KINDS, NODE_PORTS, NODE_TYPES, PORT_TYPES, defaultPortName, validateConnection } from '../src/index.ts'
import type { NodeType } from '../src/index.ts'

const schemaPath = new URL('../../db/prisma/schema.prisma', import.meta.url)
const schema = readFileSync(schemaPath, 'utf8')

function enumValues(source: string, name: string): string[] {
  const match = new RegExp(`enum\\s+${name}\\s*\\{([\\s\\S]*?)\\}`).exec(source)
  if (!match?.[1]) throw new Error(`schema.prisma 中找不到 enum ${name}`)
  return match[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.length > 0)
}

test('17 个节点类型一个不多一个不少', () => {
  assert.equal(NODE_TYPES.length, 17)
  assert.equal(new Set(NODE_TYPES).size, 17)
})

test('端口声明覆盖全部 17 个类型，且端口类型都在 PORT_TYPES 内', () => {
  for (const type of NODE_TYPES) {
    const ports = NODE_PORTS[type]
    assert.ok(ports, `${type} 缺少端口声明`)
    const all = [...ports.inputs, ...ports.outputs]
    assert.ok(all.length > 0, `${type} 至少要有一个端口`)
    for (const port of all) {
      assert.ok(
        (PORT_TYPES as readonly string[]).includes(port.type),
        `${type}.${port.name} 的端口类型 ${port.type} 不在 PORT_TYPES 里`,
      )
    }
  }
})

test('source 没有输入端口：文件来自上传，不来自上游节点', () => {
  assert.equal(NODE_PORTS.SOURCE.inputs.length, 0)
})

test('N1 source.out(SourceDoc) → card.in(ConceptClaims) 必须 400', () => {
  const result = validateConnection({ fromType: 'SOURCE', fromPort: 'out', toType: 'CARD', toPort: 'in' })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'EDGE_PORT_TYPE_MISMATCH')
})

test('N2 chunk.out(ChunkSet) → paper.in(VerifiedProblems) 必须 400', () => {
  const result = validateConnection({ fromType: 'CHUNK', fromPort: 'out', toType: 'PAPER', toPort: 'in' })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'EDGE_PORT_TYPE_MISMATCH')
})

test('N3 extract.out(ConceptClaims) → check.in(ProblemSet) 必须 400', () => {
  const result = validateConnection({ fromType: 'EXTRACT', fromPort: 'out', toType: 'CHECK', toPort: 'in' })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'EDGE_PORT_TYPE_MISMATCH')
})

test('N4 card.out(ConceptCardSet) → chunk.in(SourceDoc) 必须 400', () => {
  const result = validateConnection({ fromType: 'CARD', fromPort: 'out', toType: 'CHUNK', toPort: 'in' })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'EDGE_PORT_TYPE_MISMATCH')
})

const positiveCases: ReadonlyArray<readonly [NodeType, string, NodeType, string, string]> = [
  ['SOURCE', 'out', 'CHUNK', 'in', 'SourceDoc'],
  ['CHUNK', 'out', 'EXTRACT', 'in', 'ChunkSet'],
  ['EXTRACT', 'out', 'CARD', 'in', 'ConceptClaims'],
  ['CARD', 'out', 'PREREQ', 'in', 'ConceptCardSet'],
  ['CARD', 'out', 'QUIZ', 'in', 'ConceptCardSet'],
  ['QUIZ', 'out', 'GATE', 'in', 'ProblemSet'],
  ['QUIZ', 'out', 'VARIANT', 'in', 'ProblemSet'],
  ['SOLVE', 'out', 'METHOD', 'solution', 'SolutionTrace'],
  ['DISTRACTOR', 'out', 'CHECK', 'in', 'ProblemSet'],
  ['CHECK', 'out', 'PAPER', 'in', 'VerifiedProblems'],
  ['GRADE', 'out', 'REVIEW', 'in', 'GradeResult'],
  ['GRADE', 'out', 'DIAGNOSE', 'in', 'GradeResult'],
]

for (const [fromType, fromPort, toType, toPort, expected] of positiveCases) {
  test(`正例 ${fromType}.${fromPort} → ${toType}.${toPort} 应放行（${expected}）`, () => {
    const result = validateConnection({ fromType, fromPort, toType, toPort })
    assert.equal(result.ok, true)
    assert.equal(result.ok === true && result.portType, expected)
  })
}

test('端口名不存在时报 EDGE_PORT_NOT_FOUND，并区分 from / to', () => {
  const missingFrom = validateConnection({ fromType: 'CHUNK', fromPort: 'nope', toType: 'EXTRACT', toPort: 'in' })
  assert.equal(missingFrom.ok, false)
  assert.equal(missingFrom.ok === false && missingFrom.code, 'EDGE_PORT_NOT_FOUND')
  assert.equal(missingFrom.ok === false && missingFrom.details.side, 'from')

  const missingTo = validateConnection({ fromType: 'CHUNK', fromPort: 'out', toType: 'EXTRACT', toPort: 'nope' })
  assert.equal(missingTo.ok, false)
  assert.equal(missingTo.ok === false && missingTo.code, 'EDGE_PORT_NOT_FOUND')
  assert.equal(missingTo.ok === false && missingTo.details.side, 'to')
})

test('默认端口名：单端口可推断，多端口必须显式指定', () => {
  assert.equal(defaultPortName('CHUNK', 'input'), 'in')
  assert.equal(defaultPortName('CHUNK', 'output'), 'out')
  assert.equal(defaultPortName('METHOD', 'input'), undefined, 'method 有 problem/solution 两个入口')
  assert.equal(defaultPortName('SOURCE', 'input'), undefined)
})

test('入口端口不允许被连线灌入（N5）：EDGE_PORT_EXTERNAL', () => {
  const result = validateConnection({ fromType: 'CHUNK', fromPort: 'out', toType: 'SOLVE', toPort: 'problem' })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'EDGE_PORT_EXTERNAL')
})

test('入口端口类型没有任何节点能产出（ProblemInput / AnswerRecord 只能来自外部）', () => {
  const produced = new Set<string>()
  for (const type of NODE_TYPES) {
    for (const port of NODE_PORTS[type].outputs) produced.add(port.type)
  }

  for (const type of NODE_TYPES) {
    for (const port of NODE_PORTS[type].inputs) {
      if (port.external !== true) continue
      assert.equal(
        produced.has(port.type),
        false,
        `${type}.${port.name} 被标成入口端口，但有节点在产出 ${port.type}——要么去掉 external，要么那是死端口`,
      )
    }
  }
})

test('每个入口端口都能在文档矩阵里找到对应说明（数量对得上）', () => {
  const externalPorts = NODE_TYPES.flatMap((type) =>
    NODE_PORTS[type].inputs
      .filter((port) => port.external === true)
      .map((port) => `${type}.${port.name}:${port.type}`),
  ).sort()

  assert.deepEqual(externalPorts, [
    'GRADE.in:AnswerRecord',
    'METHOD.problem:ProblemInput',
    'PROBE.problem:ProblemInput',
    'SOLVE.problem:ProblemInput',
  ])
})

test('端口类型不匹配的 details 足以解释给学生听', () => {
  const result = validateConnection({ fromType: 'SOURCE', fromPort: 'out', toType: 'CARD', toPort: 'in' })
  assert.equal(result.ok, false)
  if (result.ok === false) {
    assert.equal(result.details.fromPortType, 'SourceDoc')
    assert.equal(result.details.toPortType, 'ConceptClaims')
    assert.match(result.message, /不匹配/)
  }
})

test('契约与 Prisma schema 不漂移：NodeType / EdgeKind 逐字一致', () => {
  assert.deepEqual([...enumValues(schema, 'NodeType')].sort(), [...NODE_TYPES].sort())
  assert.deepEqual([...enumValues(schema, 'EdgeKind')].sort(), [...EDGE_KINDS].sort())
})

test('Edge 仍然只有三种语义（第四种 = P0）', () => {
  assert.equal(EDGE_KINDS.length, 3)
  assert.deepEqual([...EDGE_KINDS].sort(), ['CITES', 'DERIVED_FROM', 'PREREQUISITE'])
})
