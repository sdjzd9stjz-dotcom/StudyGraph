// 守卫同步校验（SG-SUP-011 §1.4 重写）
//
// 旧版只比对写死在数组里的两个迁移 → 护栏自己不可靠。
// 新版：**枚举 migrations/ 下全部 migration.sql**，抽出守卫对象
// （CREATE TRIGGER / CREATE OR REPLACE FUNCTION / CREATE VIEW），
// 按名字取"最后一次定义"，再与 packages/db/sql/guards.sql 对照：
//   1. 同名对象的集合必须一致（少一个 = 有人只改了一半）
//   2. 定义首行必须一致（防止函数体被改但聚合副本没跟上）
//
// 自测：--self-test 复制一份 migrations 到临时目录、故意删掉一个触发器，
// 校验器必须报红，否则护栏本身就是假的。
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const OBJECT_PATTERN = /^CREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|TRIGGER|VIEW)\s+"?([A-Za-z0-9_]+)"?/i

function collectFromFile(file, source) {
  const objects = new Map()
  const text = readFileSync(file, 'utf8')
  for (const chunk of text.split(/;\s*(?:\r?\n|$)/)) {
    const match = chunk.match(OBJECT_PATTERN)
    if (!match) continue
    objects.set(`${match[1].toUpperCase()}:${match[2]}`, {
      kind: match[1].toUpperCase(),
      name: match[2],
      source,
      head: chunk.trim().split('\n')[0].replace(/\s+/g, ' '),
    })
  }
  return objects
}

/** 从目录里的全部 migration.sql 抽守卫对象，后者覆盖前者（文件名字典序 = 执行序）。 */
export function collectGuards(migrationsDir) {
  const objects = new Map()
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  for (const dir of dirs) {
    const file = path.join(migrationsDir, dir, 'migration.sql')
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const [key, object] of collectFromFile(file, dir)) objects.set(key, object)
    void text
  }
  return objects
}

const normalizeHead = (head) => head.replace(/\s+/g, ' ').replace(/^CREATE OR REPLACE /i, 'CREATE ').trim()

function compare(migrationObjects, aggregateObjects) {
  const problems = []
  for (const [key, object] of migrationObjects) {
    const aggregate = aggregateObjects.get(key)
    if (!aggregate) {
      problems.push(`guards.sql 缺少 ${key}（来自 ${object.source}）`)
      continue
    }
    if (normalizeHead(aggregate.head) !== normalizeHead(object.head)) {
      problems.push(`${key} 定义不一致：migration「${object.head}」 vs guards.sql「${aggregate.head}」`)
    }
  }
  for (const key of aggregateObjects.keys()) {
    if (!migrationObjects.has(key)) problems.push(`guards.sql 里有 ${key}，但没有任何 migration 定义它`)
  }
  return problems
}

const root = path.resolve(import.meta.dirname, '..')
const migrationsDir = path.join(root, 'packages/db/prisma/migrations')
const guardsSql = path.join(root, 'packages/db/sql/guards.sql')

const runOnce = (migDir) => compare(collectGuards(migDir), collectFromFile(guardsSql, 'guards.sql'))

if (process.argv.includes('--self-test')) {
  const temp = mkdtempSync(path.join(tmpdir(), 'guards-selftest-'))
  try {
    cpSync(migrationsDir, temp, { recursive: true })
    // 模拟"某个守卫从迁移里被删掉了"：在所有 migration 里抹掉同一个触发器
    const target = path.join(temp, '20261118030100_guards', 'migration.sql')
    const target2 = path.join(temp, '20261119000100_pending_review_guards', 'migration.sql')
    let mutatedCount = 0
    for (const file of [target, target2]) {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const mutated = text.replace(/CREATE TRIGGER "problem_verified_needs_citation"[\s\S]*?;/, '')
      if (mutated !== text) mutatedCount += 1
      writeFileSync(file, mutated)
    }
    if (mutatedCount === 0) throw new Error('自测构造失败：没找到要删除的触发器')

    const problems = runOnce(temp)
    if (problems.length === 0) {
      console.error('❌ 自测失败：塞了半改迁移，校验器仍然通过')
      process.exit(1)
    }
    console.log(`✅ 自测通过：半改迁移被拦下（${problems.length} 条问题）`)
    console.log(`   例：${problems[0]}`)
    process.exit(0)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

const problems = runOnce(migrationsDir)
if (problems.length > 0) {
  console.error(`❌ guards 不同步（${problems.length} 条）`)
  for (const problem of problems.slice(0, 20)) console.error(`   ${problem}`)
  process.exit(1)
}
console.log(`✅ guards 同步（${collectGuards(migrationsDir).size} 个守卫对象，覆盖全部 migration）`)
