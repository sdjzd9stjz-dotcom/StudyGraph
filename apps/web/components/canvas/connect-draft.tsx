'use client'

import { createContext, useContext } from 'react'

/**
 * 拖线中的高亮状态，用 context 下发而不是塞进 node.data。
 *
 * 为什么必须这样（用户 2026-11-24 反复报「组右侧出点拖不出线」）：
 * 之前高亮写在 `groupNodes` 的 memo 里，依赖 `connectDraft` ——
 * 一按下出点，setConnectDraft 就让每个组节点变成**新对象**，
 * React Flow 重新 adopt 这些节点时，内部缓存的端口位置（handleBounds）
 * 有可能作废，而拖动过程中不会再有 ResizeObserver 回调把尺寸补回来，
 * 结果就是"按得下去、拉不出线"。
 *
 * 走 context 后：组节点对象保持稳定（不再依赖 connectDraft），
 * 只有节点组件本身因为 context 变化而重渲染 —— 高亮照常更新，节点不被重建。
 */
export type GroupConnectHighlight = 'origin' | 'compatible' | 'incompatible' | null

export interface ConnectDraftValue {
  /** 拖线起点是不是这个组自己 */
  isOrigin: (groupId: string) => boolean
  /** 这个组在当前拖线里能不能被接上 */
  highlightFor: (groupId: string) => GroupConnectHighlight
}

export const ConnectDraftContext = createContext<ConnectDraftValue | null>(null)

export function useConnectDraftValue(): ConnectDraftValue | null {
  return useContext(ConnectDraftContext)
}
