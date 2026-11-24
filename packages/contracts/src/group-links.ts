/**
 * 组可以接到哪些节点上。
 *
 * 用户 2026-11-24 要求：「为组添加可以接到的节点：复习、深入理解、导出讲义、先修」。
 *
 * 为什么是这四类、而不是全部：
 *   · 深入理解 / 导出讲义 —— 执行器真的会读 `upstreamContext`，
 *     组的成员产物会作为材料进入它们的上下文，接了有实际效果。
 *   · 复习 / 先修 —— 它们按画布上的概念排计划，接组的意义是"只用这一组里的概念"，
 *     执行器按 `groupContext` 收窄范围。
 *   · 出题（QUIZ）等节点**故意不给**：它们的输入是具体的概念卡产物，
 *     组提供的是一批节点的摘要，混进来会让"这道题考的是哪张卡"变得说不清。
 *
 * 放在 contracts 而不是界面里：前端高亮、前端接线、服务端落库三处必须用同一张表，
 * 否则会出现"界面亮着能接、服务端 400 拒绝"这种最让人困惑的状态。
 */
export const GROUP_LINK_TARGETS = ['REVIEW', 'DEEPEN', 'LECTURE', 'PREREQ'] as const

export type GroupLinkTarget = (typeof GROUP_LINK_TARGETS)[number]

export function canLinkGroupTo(nodeType: string): boolean {
  return (GROUP_LINK_TARGETS as readonly string[]).includes(nodeType)
}

/** 给人看的一句话说明，用在提示与文档里，避免各处措辞不一致 */
export const GROUP_LINK_HINT = '组可以接到：复习 / 深入理解 / 导出讲义 / 先修'
