/**
 * 端口类型与连线校验。
 *
 * 规格没有定义 17 个节点各自的端口类型，这是实施决策（见 docs/milestone-1.md §3）。
 * 判定规则只有一条：**from 端口类型必须与 to 端口类型同名**。
 *
 * 这份模块被两边共用：
 *   - 前端 onConnect 用它即时提示（不让用户连出一条注定 400 的线）
 *   - 服务端 POST /v1/canvases/:id/edges 用它判定 400
 * 双端同源，才谈得上"UI 层与服务层双重拒绝"。
 */
import type { NodeType } from './node-types.ts'

export const PORT_TYPES = [
  'SourceDoc',
  'ChunkSet',
  'ConceptClaims',
  'ConceptCardSet',
  'GraphPatch',
  'ProblemSet',
  'VerifiedProblems',
  'ProblemInput',
  'ProbeProfile',
  'MethodCard',
  'SolutionTrace',
  'Diagnosis',
  'AnswerRecord',
  'GradeResult',
  'ReviewPlan',
  'PaperSpec',
  /** 深入理解：核心观点（可回指知识卡与题目） */
  'DeepInsight',
  /** 讲义：多节点问答归纳出的成稿 */
  'LectureDoc',
] as const

export type PortType = (typeof PORT_TYPES)[number]

export interface PortSpec {
  readonly name: string
  /** 主类型。`accepts` 存在时，它只是"默认显示"的那一个，判定以 accepts 为准。 */
  readonly type: PortType
  /**
   * 这个入口还能接受哪些上游类型（联合入口）。
   *
   * 「深入理解」只该吃知识卡和题目，「导出讲义」要把整张图都收进来 ——
   * 它们不可能各配七八个同名端口，所以允许一个端口收多种类型。
   * 不填时等价于 `[type]`，旧端口的行为完全不变。
   */
  readonly accepts?: readonly PortType[]
  /**
   * 入口端口：数据来自画布外部（粘贴题目 / 上传作答），不由连线供给。
   * 向这类端口连线必须 400（EDGE_PORT_EXTERNAL），UI 上渲染成"上传/粘贴槽"而不是连接点。
   */
  readonly external?: boolean
}

export interface NodePorts {
  readonly inputs: readonly PortSpec[]
  readonly outputs: readonly PortSpec[]
}

/**
 * 各节点的端口声明。
 * `source` 没有输入端口：文件来自 params / 上传，不来自上游节点。
 */
export const NODE_PORTS: Readonly<Record<NodeType, NodePorts>> = {
  SOURCE: { inputs: [], outputs: [{ name: 'out', type: 'SourceDoc' }] },

  CHUNK: { inputs: [{ name: 'in', type: 'SourceDoc' }], outputs: [{ name: 'out', type: 'ChunkSet' }] },
  EXTRACT: { inputs: [{ name: 'in', type: 'ChunkSet' }], outputs: [{ name: 'out', type: 'ConceptClaims' }] },
  CARD: { inputs: [{ name: 'in', type: 'ConceptClaims' }], outputs: [{ name: 'out', type: 'ConceptCardSet' }] },
  PREREQ: { inputs: [{ name: 'in', type: 'ConceptCardSet' }], outputs: [{ name: 'out', type: 'GraphPatch' }] },
  QUIZ: { inputs: [{ name: 'in', type: 'ConceptCardSet' }], outputs: [{ name: 'out', type: 'ProblemSet' }] },
  GRADE: {
    inputs: [{ name: 'in', type: 'AnswerRecord', external: true }],
    outputs: [{ name: 'out', type: 'GradeResult' }],
  },
  REVIEW: { inputs: [{ name: 'in', type: 'GradeResult' }], outputs: [{ name: 'out', type: 'ReviewPlan' }] },
  // 人工闸门：通过后原样放行同一批题，不改变数据类型
  GATE: { inputs: [{ name: 'in', type: 'ProblemSet' }], outputs: [{ name: 'out', type: 'ProblemSet' }] },

  PROBE: {
    // 题面由学生粘贴/拍照进来，不来自其它节点
    inputs: [{ name: 'problem', type: 'ProblemInput', external: true }],
    outputs: [{ name: 'out', type: 'ProbeProfile' }],
  },
  METHOD: {
    inputs: [
      { name: 'problem', type: 'ProblemInput', external: true },
      { name: 'solution', type: 'SolutionTrace' },
    ],
    outputs: [{ name: 'out', type: 'MethodCard' }],
  },
  SOLVE: {
    inputs: [{ name: 'problem', type: 'ProblemInput', external: true }],
    outputs: [{ name: 'out', type: 'SolutionTrace' }],
  },
  DIAGNOSE: { inputs: [{ name: 'in', type: 'GradeResult' }], outputs: [{ name: 'out', type: 'Diagnosis' }] },

  VARIANT: { inputs: [{ name: 'in', type: 'ProblemSet' }], outputs: [{ name: 'out', type: 'ProblemSet' }] },
  DISTRACTOR: { inputs: [{ name: 'in', type: 'ProblemSet' }], outputs: [{ name: 'out', type: 'ProblemSet' }] },
  CHECK: { inputs: [{ name: 'in', type: 'ProblemSet' }], outputs: [{ name: 'out', type: 'VerifiedProblems' }] },
  PAPER: { inputs: [{ name: 'in', type: 'VerifiedProblems' }], outputs: [{ name: 'out', type: 'PaperSpec' }] },

  /**
   * 深入理解：**只**接受知识卡与题目，没有别的入口。
   * 这不是提示词约束 —— 端口判定在 UI 与服务端双重执行，连不上就是连不上。
   */
  DEEPEN: {
    inputs: [{ name: 'in', type: 'ConceptCardSet', accepts: ['ConceptCardSet', 'ProblemSet'] }],
    outputs: [{ name: 'out', type: 'DeepInsight' }],
  },
  /**
   * 导出讲义：把画布上任意节点的产出与对话收进来归纳成一份讲义。
   * 接受所有「节点产出」类型（不含外部输入端口的那种）。
   */
  LECTURE: {
    inputs: [
      {
        name: 'context',
        type: 'ConceptCardSet',
        accepts: [
          'SourceDoc',
          'ChunkSet',
          'ConceptClaims',
          'ConceptCardSet',
          'GraphPatch',
          'ProblemSet',
          'VerifiedProblems',
          'ProbeProfile',
          'MethodCard',
          'SolutionTrace',
          'Diagnosis',
          'GradeResult',
          'ReviewPlan',
          'PaperSpec',
          'DeepInsight',
        ],
      },
    ],
    outputs: [{ name: 'out', type: 'LectureDoc' }],
  },
}

/** 服务端 400 的 errorCode。与 docs/milestone-1.md §1 的校验顺序一一对应。 */
export type ConnectionErrorCode = 'EDGE_PORT_NOT_FOUND' | 'EDGE_PORT_TYPE_MISMATCH' | 'EDGE_PORT_EXTERNAL'

export type ConnectionCheck =
  | { readonly ok: true; readonly portType: PortType }
  | {
      readonly ok: false
      readonly code: ConnectionErrorCode
      readonly message: string
      readonly details: Readonly<Record<string, unknown>>
    }

export interface ConnectionInput {
  readonly fromType: NodeType
  readonly fromPort: string
  readonly toType: NodeType
  readonly toPort: string
}

function findPort(ports: readonly PortSpec[], name: string): PortSpec | undefined {
  return ports.find((port) => port.name === name)
}

/**
 * 连线合法性判定。纯函数，不碰数据库，因此 UI 与服务端能跑同一套断言。
 */
export function validateConnection(input: ConnectionInput): ConnectionCheck {
  const fromPorts = NODE_PORTS[input.fromType].outputs
  const toPorts = NODE_PORTS[input.toType].inputs

  const from = findPort(fromPorts, input.fromPort)
  if (!from) {
    return {
      ok: false,
      code: 'EDGE_PORT_NOT_FOUND',
      message: `${input.fromType} 没有名为 "${input.fromPort}" 的输出端口`,
      details: {
        side: 'from',
        nodeType: input.fromType,
        port: input.fromPort,
        available: fromPorts.map((p) => p.name),
      },
    }
  }

  const to = findPort(toPorts, input.toPort)
  if (!to) {
    return {
      ok: false,
      code: 'EDGE_PORT_NOT_FOUND',
      message: `${input.toType} 没有名为 "${input.toPort}" 的输入端口`,
      details: {
        side: 'to',
        nodeType: input.toType,
        port: input.toPort,
        available: toPorts.map((p) => p.name),
      },
    }
  }

  if (to.external === true) {
    return {
      ok: false,
      code: 'EDGE_PORT_EXTERNAL',
      message: `${input.toType}.${to.name} 是入口端口（${to.type}），数据由外部输入提供，不能由连线灌入`,
      details: {
        side: 'to',
        nodeType: input.toType,
        port: to.name,
        portType: to.type,
      },
    }
  }

  // 联合入口：`accepts` 里任一类型都算匹配；没写 accepts 就是严格同名（旧行为）
  const accepted = to.accepts ?? [to.type]
  if (!accepted.includes(from.type)) {
    return {
      ok: false,
      code: 'EDGE_PORT_TYPE_MISMATCH',
      message: `端口类型不匹配：${input.fromType}.${from.name}(${from.type}) → ${input.toType}.${to.name}(${accepted.join(' | ')})`,
      details: {
        fromPort: from.name,
        fromPortType: from.type,
        toPort: to.name,
        toPortType: to.type,
        accepted,
      },
    }
  }

  return { ok: true, portType: from.type }
}

/**
 * 创建边时省略端口名的情况：该侧只有一个端口就用它，否则报错交给调用方处理。
 * 返回 undefined 表示"无法推断，必须显式指定"。
 */
export function defaultPortName(nodeType: NodeType, side: 'input' | 'output'): string | undefined {
  const ports = side === 'input' ? NODE_PORTS[nodeType].inputs : NODE_PORTS[nodeType].outputs
  return ports.length === 1 ? ports[0]?.name : undefined
}
