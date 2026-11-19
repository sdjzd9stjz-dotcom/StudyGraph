// guards.sql 与 guard migrations 的同步校验（无依赖，CI 与本地都能跑）
//
// packages/db/prisma/migrations/ 下的 guard migration 是被执行的那份；
// packages/db/sql/guards.sql 是给人读的聚合副本。
//
// 比对方式：去掉注释与空行后的**语句流**必须一致。
// 不比较注释，是因为 guards.sql 有自己的聚合说明头，而每个 migration 文件头讲的是它自己那条约束；
// 真正要防的是"改了源文件、跑起来的却是旧 SQL"，语句流比对刚好覆盖这一点。
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** 顺序即执行顺序，新增 guard migration 必须追加到这里。 */
const GUARD_MIGRATIONS = ['20261118030100_guards', '20261119000000_edge_no_self_loop']

const root = path.resolve(import.meta.dirname, '..')
const sourcePath = path.join(root, 'packages/db/sql/guards.sql')

function statements(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trim())
    .filter((line) => line.length > 0)
}

const expected = GUARD_MIGRATIONS.flatMap((name) =>
  statements(readFileSync(path.join(root, 'packages/db/prisma/migrations', name, 'migration.sql'), 'utf8')),
)
const actual = statements(readFileSync(sourcePath, 'utf8'))

if (expected.length !== actual.length) {
  console.error(`❌ guards.sql 与 migration 语句行数不一致：migration ${expected.length} 行 / guards.sql ${actual.length} 行`)
  console.error(`   参与的 migration：${GUARD_MIGRATIONS.join(', ')}`)
  console.error('   修法：node tmp/build-guards-sql.mjs 重建后重跑')
  process.exit(1)
}

for (let i = 0; i < expected.length; i++) {
  if (expected[i] !== actual[i]) {
    console.error(`❌ 第 ${i + 1} 行语句不一致`)
    console.error(`   migration : ${expected[i]}`)
    console.error(`   guards.sql: ${actual[i]}`)
    console.error('   修法：node tmp/build-guards-sql.mjs 重建后重跑')
    process.exit(1)
  }
}

console.log(`✅ guards 同步（${GUARD_MIGRATIONS.length} 份 migration，${actual.length} 行语句流一致）`)
