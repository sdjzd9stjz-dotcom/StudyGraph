/**
 * 客户端可用的契约导出（SG-SUP-017 §12 溯源抽屉）。
 *
 * 为什么需要这个文件：`index.ts` 这个 barrel 还导出了 `fingerprint.ts`，
 * 而后者 `import { createHash } from 'node:crypto'` —— 浏览器 bundle 里没有 `node:crypto`，
 * 客户端组件只要从 `index.ts` 取一个常量，整个 barrel 都会被拖进来，构建直接失败。
 *
 * 这里只放**纯数据与纯函数**（端口矩阵、节点类型、边类型、阈值），
 * 任何需要 Node 内置模块的东西都留在 `index.ts`（服务端专用）。
 *
 * 端口矩阵仍然只有一份（`./ports.ts`），**不许为了打包方便复制第二份**。
 */
export { REQUIRED_CAPABILITY, TASK_TYPE_KEYS, TASK_LABELS, isTaskType } from './task-capabilities.ts'

export { NODE_TYPES, NODE_BATCH, isNodeType } from './node-types.ts'
export type { NodeType } from './node-types.ts'

export { EDGE_KINDS, isEdgeKind } from './edges.ts'
export type { EdgeKind } from './edges.ts'

export { PORT_TYPES, NODE_PORTS, validateConnection, defaultPortName } from './ports.ts'
export type {
  PortType,
  PortSpec,
  NodePorts,
  ConnectionCheck,
  ConnectionErrorCode,
  ConnectionInput,
} from './ports.ts'

export * from './thresholds.ts'
