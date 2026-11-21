import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { registerBuiltinExecutors } from '../../src/nodes/executors/index.ts'
import { implementedTypes, getExecutor } from '../../src/nodes/registry.ts'

/**
 * 执行器声明的 `artifactKind` 必须是数据库 `ArtifactKind` 枚举里真实存在的值。
 *
 * 为什么值得一条专门的测试：写入产物时用的是 `kind: executor.artifactKind as never`，
 * `as never` 把类型检查整个绕过了。写错一个值时：
 *   · 编译通过
 *   · 类型检查通过
 *   · 跑起来**模型费已经扣了**，写 Artifact 那一步才报 Invalid value for argument `kind`
 * 也就是说，学生花了钱、拿到一个失败节点，而错误信息只提到枚举值。
 *
 * 曾经真实发生过：8 个执行器的产物类型与枚举对不上（PAPER / PROBLEM_SET / QUALITY_CHECK …）。
 * 删掉这条测试，下一次改名或新增节点又会静默复发。
 */

/** 从 schema.prisma 里读 ArtifactKind 的成员，不依赖数据库连接 */
function readArtifactKinds(): Set<string> {
  const schemaPath = path.resolve(import.meta.dirname, '../../../../packages/db/prisma/schema.prisma')
  const schema = readFileSync(schemaPath, 'utf8')
  const block = schema.match(/enum ArtifactKind \{([\s\S]*?)\n\}/)
  assert.ok(block, 'schema.prisma 里找不到 enum ArtifactKind')

  const members = new Set<string>()
  for (const line of block[1]!.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('//')) continue
    const name = trimmed.split(/\s+/)[0]
    if (name && /^[A-Z_]+$/.test(name)) members.add(name)
  }
  return members
}

test('每个执行器的 artifactKind 都在 ArtifactKind 枚举里', () => {
  registerBuiltinExecutors()
  const kinds = readArtifactKinds()
  assert.ok(kinds.size > 10, `枚举解析异常，只读到 ${kinds.size} 个值`)

  const offenders: string[] = []
  for (const type of implementedTypes()) {
    const executor = getExecutor(type)
    // artifactKind 在契约里是 string，运行时才和枚举对齐 —— 正是这里要守的原因
    if (!kinds.has(executor.artifactKind)) {
      offenders.push(`${type} → ${executor.artifactKind}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `这些执行器的产物类型在数据库枚举里不存在，运行时会在扣完模型费之后才报错：\n- ${offenders.join('\n- ')}`,
  )
})

test('GATE 用自己的产物类型，不再借用 REVIEW_PLAN', () => {
  registerBuiltinExecutors()
  assert.equal(getExecutor('GATE').artifactKind, 'GATE_DECISION')
  assert.notEqual(
    getExecutor('GATE').artifactKind,
    getExecutor('REVIEW').artifactKind,
    '闸门决策与复习计划必须在数据上可分',
  )
})
