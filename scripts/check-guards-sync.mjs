// guards.sql 与 migration 的同步校验（无依赖，CI 与本地都能跑）
//
// packages/db/prisma/migrations/20261118030100_guards/migration.sql 是被执行的那份；
// packages/db/sql/guards.sql 是给 reviewers 直接读的副本。两者必须逐字节一致，
// 否则会出现"改了源文件、跑起来的是旧 SQL"这种最难查的问题。
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const migration = path.join(root, 'packages/db/prisma/migrations/20261118030100_guards/migration.sql')
const source = path.join(root, 'packages/db/sql/guards.sql')

const normalize = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const a = normalize(migration)
const b = normalize(source)

if (a !== b) {
  console.error('❌ guards.sql 与 guards migration 内容不一致')
  console.error(`   migration: ${migration} (${a.length} chars)`)
  console.error(`   guards.sql: ${source} (${b.length} chars)`)
  console.error('   修法：把 migration.sql 原样复制到 packages/db/sql/guards.sql')
  process.exit(1)
}

console.log(`✅ guards 同步（${a.length} chars, ${a.split('\n').length} 行）`)
