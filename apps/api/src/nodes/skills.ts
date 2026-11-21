import type { PrismaClient } from '../../../../packages/db/src/index.ts'

/**
 * F2 · Skill 指令包（M4.5）。
 *
 * 四条约束（规格原文，与硬约束同级）：
 *   1. 必须**显式绑定到节点**，不做全局自动加载；绑了哪些、各自 version 多少，全部进指纹
 *   2. 正文只能**追加到 system 前缀**，不得改写用户输入；与硬约束冲突时以硬约束为准
 *   3. scope=USER 的读取必须带 ownerId，与他人隔离
 *   4. skill 不得包含凭据
 *
 * 注入顺序固定：硬约束摘要 → skill（按 slug 排序）→ 节点 prompt。
 * 顺序固定是为了让「同样的输入 + 同样的 skill 集合」得到同样的前缀 ——
 * 前缀缓存以这个字符串为准（Anthropic 的 cachePrefix、OpenAI 的自动前缀）。
 */

export interface BoundSkill {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly instructions: string
  /** 进指纹：改正文必须让缓存失效 */
  readonly version: number
}

/**
 * 读节点绑定的 skill。
 *
 * 过滤掉 `enabled=false` 的：禁用的 skill 不该影响结果，也就不该影响指纹 ——
 * 否则"关掉一个 skill"会莫名其妙地让所有缓存失效。
 */
export async function loadNodeSkills(prisma: PrismaClient, nodeId: string, userId: string): Promise<BoundSkill[]> {
  const rows = await prisma.nodeSkill.findMany({
    where: { nodeId, skill: { enabled: true, OR: [{ scope: 'BUILTIN' }, { ownerId: userId }] } },
    select: { skill: { select: { id: true, slug: true, name: true, instructions: true, version: true } } },
  })

  // 按 slug 排序：集合相同但插入顺序不同，指纹必须一致
  return rows.map((row) => row.skill).sort((a, b) => a.slug.localeCompare(b.slug))
}

/** 进指纹的形状：只含"会影响输出"的东西（slug + version），不含正文全文 */
export function skillFingerprintPayload(skills: readonly BoundSkill[]): Array<{ slug: string; version: number }> {
  return skills.map((skill) => ({ slug: skill.slug, version: skill.version }))
}

/**
 * 拼 system 前缀。
 *
 * `hardRules` 放最前面且**不可被 skill 覆盖** —— 规格要求"含指令冲突时以硬约束为准"。
 * 实现上不是靠"让模型听话"，而是把硬约束文字放在最前，并在 skill 段落标题里
 * 明确写"以下说明不得违反上面的硬约束"。
 */
export function composeSystemPrompt(hardRules: string, skills: readonly BoundSkill[], nodePrompt: string): string {
  if (skills.length === 0) return nodePrompt

  const skillSection = skills
    .map((skill) => `### ${skill.name}（${skill.slug} v${skill.version}）\n${skill.instructions}`)
    .join('\n\n')

  return [
    hardRules.trim(),
    '',
    '## 附加说明（不得违反上面任何一条硬约束；若冲突，以硬约束为准）',
    '',
    skillSection,
    '',
    nodePrompt.trim(),
  ].join('\n')
}

/** 溯源相关硬约束的摘要：所有调模型的执行器共享同一份，避免各家写法不一致 */
export const HARD_RULE_SUMMARY = [
  '硬约束（不可违反）：',
  '1. 溯源是物理约束：没有原文引用的结论不得成为已确认知识。',
  '2. 执行必须显式触发：你只回答问题，不得自行触发其他步骤。',
  '3. 写作类只给骨架：不代写正文。',
].join('\n')

/**
 * 把节点自己写的提示词（`params.prompt`）合成为一条附加 skill。
 *
 * 为什么走 skill 通道：所有执行器拼系统提示词都只调 `composeSystemPrompt`，
 * 而它把 skills 放在硬约束**之后**。这样学生能补充要求（"只考计算题"），
 * 但推不翻硬约束（"没有原文引用不得成为已确认知识"）。
 *
 * 不逐个执行器加参数：13 个执行器少改一个，那个节点的提示词就会被静默忽略 ——
 * 而这种忽略在界面上完全看不出来（提示词存进去了，就是不生效）。
 */
export function withNodePrompt(
  boundSkills: readonly BoundSkill[],
  prompt: unknown,
): readonly BoundSkill[] {
  if (typeof prompt !== 'string') return boundSkills
  const text = prompt.trim()
  if (text.length === 0) return boundSkills
  return [
    ...boundSkills,
    { id: 'node-prompt', slug: 'node-prompt', name: '节点提示词', instructions: text, version: 1 },
  ]
}
