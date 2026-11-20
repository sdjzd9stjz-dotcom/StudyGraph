// 守卫同步校验（SG-SUP-012：覆盖全部 migration，正文逐字比对，双向自测）
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PATTERN = /^CREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|TRIGGER|VIEW)\s+"?([A-Za-z0-9_]+)"?/i
const root = path.resolve(import.meta.dirname, '..')
const migrationsDir = path.join(root, 'packages/db/prisma/migrations')
const guardsSql = path.join(root, 'packages/db/sql/guards.sql')

const clean = (chunk) => chunk.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim().replace(/^CREATE OR REPLACE /i, 'CREATE ')

function collectFromFile(file, source, into) {
  for (const chunk of readFileSync(file, 'utf8').split(/;\s*(?:\r?\n|$)/)) {
    const match = chunk.trimStart().match(PATTERN)
    if (!match) continue
    into.set(`${match[1].toUpperCase()}:${match[2]}`, { source, body: clean(chunk) })
  }
  return into
}

export function collectGuards(dir) {
  const objects = new Map()
  const dirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  for (const name of dirs) {
    try {
      collectFromFile(path.join(dir, name, 'migration.sql'), name, objects)
    } catch {
      /* 该目录没有 migration.sql */
    }
  }
  return objects
}

function compare(migrationObjects, aggregateObjects) {
  const problems = []
  for (const [key, object] of migrationObjects) {
    const other = aggregateObjects.get(key)
    if (!other) problems.push(`guards.sql 缺少 ${key}（来自 ${object.source}）`)
    else if (other.body !== object.body) problems.push(`${key} 定义不一致（migration 与 guards.sql 的正文不同）`)
  }
  for (const key of aggregateObjects.keys()) if (!migrationObjects.has(key)) problems.push(`guards.sql 里有 ${key}，但没有任何 migration 定义它`)
  return problems
}

const aggregate = () => collectFromFile(guardsSql, 'guards.sql', new Map())

if (process.argv.includes('--rebuild')) {
  const objects = collectGuards(migrationsDir)
  const header = [
    '-- =============================================================================',
    '-- guards.sql —— 由 scripts/check-guards-sync.mjs --rebuild 生成，勿手改',
    '-- 内容 = migrations/ 下全部 migration.sql 里守卫对象的最后定义',
    '-- =============================================================================',
    '',
  ].join('\n')
  writeFileSync(guardsSql, `${header}${[...objects.values()].map((o) => `${o.body};`).join('\n\n')}\n`)
  console.log(`✅ 已重建 guards.sql（${objects.size} 个守卫对象）`)
  process.exit(0)
}

if (process.argv.includes('--self-test')) {
  const temp = mkdtempSync(path.join(tmpdir(), 'guards-selftest-'))
  try {
    cpSync(migrationsDir, temp, { recursive: true })

    const fileA = path.join(temp, '20261119000100_pending_review_guards', 'migration.sql')
    const original = readFileSync(fileA, 'utf8')
    writeFileSync(fileA, original.replace(/CREATE TRIGGER "problem_verified_needs_citation"[\s\S]*?;/, ''))
    const removed = compare(collectGuards(temp), aggregate())

    writeFileSync(fileA, original)
    const fileB = path.join(temp, '20261118030100_guards', 'migration.sql')
    const body = readFileSync(fileB, 'utf8')
    writeFileSync(fileB, body.replace('RETURN NEW;', 'RETURN  NEW;'))

    const mutated = compare(collectGuards(temp), aggregate())

    if (removed.length === 0) throw new Error('自测 1 失败：删掉守卫对象后仍然通过')
    if (mutated.length === 0) throw new Error('自测 2 失败：函数体改一个字符后仍然通过（说明只比了对象名）')

    console.log(`✅ 自测通过：删对象 → 报红（${removed.length} 条）；改函数体 → 报红（${mutated.length} 条）`)
    process.exit(0)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

const problems = compare(collectGuards(migrationsDir), aggregate())
if (problems.length > 0) {
  console.error(`❌ guards 不同步（${problems.length} 条）`)
  for (const problem of problems.slice(0, 10)) console.error(`   ${problem}`)
  process.exit(1)
}
console.log(`✅ guards 同步（${collectGuards(migrationsDir).size} 个守卫对象，覆盖全部 migration）`)
