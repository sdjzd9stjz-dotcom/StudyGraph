// 漂移防护：Prisma 无法表达 HNSW / gin_trgm 索引，`migrate dev` 生成的 migration
// 会把它们当成"多余的索引"删掉。这不是推测——SG-SUP-002 §2.3 在真实 PG16 上确认过。
//
// 本脚本跑一次 `migrate diff`（真库 → schema），一旦输出里出现对这两条索引的 DROP，
// 就 exit 1 并打印原因。CI 与本地提交前都应该跑。
//
// 为什么不做根修（把索引写进 schema.prisma）：
//   Prisma 6 无 HNSW 索引类型；gin_trgm_ops 虽可用 ops: raw(...) 表达，
//   但迁移已经建好索引，再让 Prisma 生成一次 CREATE INDEX 会撞名。
//   根修要等到能安全重建索引的窗口（M2 建库脚本里一并处理）。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

/** 由 guards migration 手写、Prisma 不认识的索引。谁丢了谁负责。 */
const PROTECTED_INDEXES = ['Concept_embedding_hnsw', 'Concept_name_trgm']

function readDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL

  const envPath = path.join(root, '.env')
  const line = readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith('DATABASE_URL='))

  if (!line) {
    console.error('❌ 找不到 DATABASE_URL（环境变量与 .env 都没有）')
    process.exit(2)
  }

  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
}

const databaseUrl = readDatabaseUrl()

let diff = ''
try {
  diff = execFileSync(
    process.execPath,
    [
      'scripts/prisma.mjs',
      'migrate',
      'diff',
      '--from-url',
      databaseUrl,
      '--to-schema-datamodel',
      'packages/db/prisma/schema.prisma',
      '--script',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
} catch (error) {
  const stderr = error.stderr ?? ''
  // 库连不上是另一种问题，要报出来，不能当成"没有漂移"
  if (!/DROP|ALTER|CREATE|^$/m.test(stderr) && stderr.includes('Error')) {
    console.error('❌ migrate diff 执行失败（数据库可能没起）')
    console.error(String(stderr).slice(0, 1200))
    process.exit(2)
  }
  diff = error.stdout ?? ''
}

const offending = diff
  .split(/\r?\n/)
  .filter((line) => /DROP\s+INDEX/i.test(line))
  .filter((line) => PROTECTED_INDEXES.some((name) => line.includes(name)))

if (offending.length > 0) {
  console.error('❌ 漂移检测：即将删除手写索引')
  console.error('')
  for (const line of offending) console.error(`   ${line.trim()}`)
  console.error('')
  console.error('   这两条索引由 packages/db/prisma/migrations/20261118030100_guards 手写，')
  console.error('   Prisma 无法从 schema.prisma 推出它们，所以 diff 会把它们当成多余的。')
  console.error('   处理方式：从生成的 migration 里删掉这些 DROP INDEX 行，再执行 migrate deploy。')
  process.exit(1)
}

const lines = diff.split(/\r?\n/).filter((line) => line.trim().length > 0)
if (lines.length === 0) {
  console.log('✅ 无漂移（schema 与库一致，手写索引未被触碰）')
} else {
  console.log(`✅ 手写索引未被触碰（diff 共 ${lines.length} 行，请人工过一遍）`)
  for (const line of lines.slice(0, 40)) console.log(`   ${line}`)
}
