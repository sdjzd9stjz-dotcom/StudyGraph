import type { NodeExecutor } from '../contract.ts'
import { ZERO_USAGE } from '../contract.ts'

/**
 * `gate` 执行器（M5）：人工闸门。
 *
 * 它做的事只有一件：**把"我检查过上游了"这个判断记下来**，并把当时看到的东西
 * 固化成产物，供以后回答「当时你为什么放行」。
 *
 * 为什么不让它"跑完就继续"：
 * 闸门的意义在于**下游在闸门放行前不该被执行**。如果 gate 自己也跑一次就返回成功，
 * 那它就只是一个装饰性的节点 —— 学生点了"运行"，下游照样能跑。
 * 所以 gate 的 run 只负责核对并记录；真正的放行动作是 `approved` 从 false 变成 true，
 * 这件事必须由人在界面上做（`POST /v1/nodes/:id/approve`）。
 *
 * 关键设计：
 * 1. **没检查就放不了行**。`approved` 必须是显式 params，缺省为 false。
 * 2. **上游必须真的有产物**。没有上游产物的闸门等于没闸门 —— 直接报错，
 *    不返回"通过"。
 * 3. **把上游摘要写进产物**。以后回溯时能看见"放行时上游长什么样"，
 *    而不是只有一个空的时间戳。
 * 4. 拒绝时必须给理由。无理由的拒绝，学生不知道要改什么。
 */

interface GateParams {
  /** 人在界面上勾选后才置 true；缺省 false */
  approved?: boolean
  /** 放行/拒绝的说明。拒绝时必填 */
  note?: string
  /** 这次闸门想检查什么（人话），会原样进产物 */
  checklist?: string[]
}

export const gateExecutor: NodeExecutor<GateParams> = {
  type: 'GATE',
  artifactKind: 'REVIEW_PLAN',
  promptVersion: 'no-prompt',
  inputs: {
    type: 'object',
    properties: {},
    required: [],
  },
  outputs: {
    type: 'object',
    properties: {
      approved: { type: 'boolean' },
      upstream: { type: 'object' },
      decidedAt: { type: 'string' },
    },
    required: ['approved', 'upstream', 'decidedAt'],
  },

  async run(ctx) {
    const approved = ctx.params?.approved === true
    const note = typeof ctx.params?.note === 'string' ? ctx.params.note.trim() : ''

    if (!approved && note.length === 0) {
      throw new Error(
        'gate 节点未放行且没有填写理由。拒绝上游时必须说明原因，' +
          '否则下游不知道要改什么（params.note 不能为空）。',
      )
    }

    const inputKeys = Object.keys(ctx.inputs ?? {})
    const upstreamArtifacts = inputKeys.length
    if (approvalRequiresUpstream(approved) && upstreamArtifacts === 0) {
      throw new Error(
        'gate 节点没有上游产物。没有可检查的内容时放行等于没设闸门；' +
          '请先把上游节点连上来并跑出产物，或在 note 里写明为何跳过检查。',
      )
    }

    // 上游摘要：只记形状，不复制全文 —— 产物要能一眼看懂"放行时上游有几个口、多大"
    const upstream: Record<string, unknown> = {}
    for (const [port, value] of Object.entries(ctx.inputs ?? {})) {
      upstream[port] = {
        kind: Array.isArray(value) ? 'array' : typeof value,
        size: Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : null,
      }
    }

    return {
      outputs: {
        approved,
        note: note.length > 0 ? note : null,
        checklist: Array.isArray(ctx.params?.checklist) ? ctx.params.checklist : [],
        upstream,
        upstreamArtifacts,
        decidedAt: new Date().toISOString(),
      },
      usage: ZERO_USAGE,
    }
  },
}

/**
 * 放行才要求上游有产物；拒绝时不要求。
 *
 * 理由：拒绝本来就是"上游有问题"的表达，可能是上游根本没跑出东西 ——
 * 这种时候还要求它有产物，会让"拒绝一个空的上游"这件事做不到。
 */
function approvalRequiresUpstream(approved: boolean): boolean {
  return approved
}
