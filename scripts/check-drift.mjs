// 漂移防护：Prisma 无法表达 HNSW / gin_trgm 索引，`migrate dev` 生成的 migration
// 会把它们当成"多余的索引"删掉。这不是推测——SG-SUP-002 §2.3 在真实 PG16 上确认过。
//
// 退出码（SG-SUP-005 缺陷 F：不许把"没连上库"当成"无漂移"）：
//   0 = 连上且无漂移
//   1 = 连上且检出受保护索引的 DROP
//   2 = 无法连接数据库，漂移**未检测**
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

const PROTECTED_INDEXES = ['Concept_embedding_hnsw', 'Concept_name_trgm']

function readDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL

  const line = readFileSync(path.join(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith('DATABASE_URL='))

  if (!line) {
    console.error('❌ 找不到 DATABASE_URL（环境变量与 .env 都没有），漂移未检测')
    process.exit(2)
  }

  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
}

const databaseUrl = readDatabaseUrl()

// 关键：看子进程的退出码，不靠 stderr 里有没有 Error 字样
const result = spawnSync(
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

const status = result.status ?? 1
if (status !== 0) {
  console.error(`❌ 无法连接数据库，漂移未检测（migrate diff 退出码 ${status}）`)
  const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim()
  if (detail) console.error(detail.split(/\r?\n/).slice(0, 6).join('\n'))
  process.exit(2)
}

const diff = result.stdout ?? ''

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

const lines = diff
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('--'))
if (lines.length === 0) {
  console.log('✅ 无漂移（schema 与库一致，手写索引未被触碰）')
  process.exit(0)
}

console.log(`✅ 手写索引未被触碰（diff 共 ${lines.length} 行，请人工过一遍）`)
for (const line of lines.slice(0, 40)) console.log(`   ${line}`)
process.exit(0)
