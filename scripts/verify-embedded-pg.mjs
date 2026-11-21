// 内置 PostgreSQL 端到端验收（不依赖 Electron）
//
// 证明四件事，每一条都写成"删掉它会漏什么 bug"：
//   1. initdb → 迁移 → 起库这条链在干净目录上真的能走通
//      删掉：用户第一次双击时的失败只能在用户机器上发现
//   2. 建出来的库结构与 Docker 开发库逐项相同（表/枚举/索引/外键/CHECK/触发器/视图/扩展）
//      删掉：迁移"没报错"但对象少建了一个，接口在运行时才炸
//   3. 第二次启动不重复跑迁移
//      删掉：每次启动重放 CREATE TABLE，用户第二次打开软件就崩
//   4. 迁移文件被改动后校验和失配会明确报错
//      删掉：新旧库结构悄悄分叉，没人发现
//
// 用法：node scripts/verify-embedded-pg.mjs [--pg-home <dir>]
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { resolveDatabase } = require('../apps/desktop/pg.cjs')

const root = path.resolve(import.meta.dirname, '..')
const argIndex = process.argv.indexOf('--pg-home')
const bundleDir = path.resolve(argIndex > 0 ? process.argv[argIndex + 1] : path.join(root, 'vendor', 'pg16'))
const migrationsDir = path.join(root, 'packages', 'db', 'prisma', 'migrations')

// 数据目录必须在 ASCII 路径下：与真实桌面环境一致，也避开本项目已知的中文路径坑。
// 用 STUDYGRAPH_DATA_DIR 隔离，避免验收过程写进真实用户数据。
const userDataDir = 'C:/tmp/sg-verify-pg'
process.env.STUDYGRAPH_DATA_DIR = userDataDir

const failures = []
const pass = (message) => console.log(`  ✅ ${message}`)
const fail = (message) => {
  failures.push(message)
  console.log(`  ❌ ${message}`)
}
const check = (condition, message) => (condition ? pass(message) : fail(message))

/** 与 Docker 开发库（pgvector/pgvector:pg16 + 同 7 份迁移）测得的结构指纹 */
const BASELINE = { tables: 35, enums: 29, indexes: 104, fks: 55, checks: 10, triggers: 6, views: 4, extensions: 2 }

const FINGERPRINT_SQL = `
select 'tables', count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'
union all select 'enums', count(distinct t.oid) from pg_type t join pg_enum e on e.enumtypid=t.oid
union all select 'indexes', count(*) from pg_indexes where schemaname='public'
union all select 'fks', count(*) from pg_constraint where contype='f'
union all select 'checks', count(*) from pg_constraint where contype='c' and conname not like '%_not_null'
union all select 'triggers', count(*) from pg_trigger where not tgisinternal
union all select 'views', count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v'
union all select 'extensions', count(*) from pg_extension where extname in ('vector','pg_trgm');
`

function fingerprint(databaseUrl, pgBinDir) {
  const url = new URL(databaseUrl)
  const result = spawnSync(
    path.join(pgBinDir, 'psql.exe'),
    ['-X', '--no-password', '-h', '127.0.0.1', '-p', url.port, '-U', decodeURIComponent(url.username), '-d', url.pathname.slice(1), '-A', '-t', '-F', '|', '-c', FINGERPRINT_SQL],
    {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password), PGCLIENTENCODING: 'UTF8' },
    },
  )
  if (result.status !== 0) throw new Error(`结构查询失败：${result.stderr}`)
  return Object.fromEntries(
    result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [key, value] = line.split('|')
        return [key, Number(value)]
      }),
  )
}

function migrationRows(databaseUrl, pgBinDir) {
  const url = new URL(databaseUrl)
  const result = spawnSync(
    path.join(pgBinDir, 'psql.exe'),
    ['-X', '--no-password', '-h', '127.0.0.1', '-p', url.port, '-U', decodeURIComponent(url.username), '-d', url.pathname.slice(1), '-A', '-t', '-c',
      `select count(*) filter (where finished_at is not null), count(*) from "_prisma_migrations"`],
    {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password), PGCLIENTENCODING: 'UTF8' },
    },
  )
  if (result.status !== 0) throw new Error(`迁移表查询失败：${result.stderr}`)
  const [finished, total] = result.stdout.trim().split('|').map(Number)
  return { finished, total }
}

/** 跑一条返回单值的查询（-A -t：无对齐、无表头） */
function query(databaseUrl, pgBinDir, sql) {
  const url = new URL(databaseUrl)
  const result = spawnSync(
    path.join(pgBinDir, 'psql.exe'),
    ['-X', '--no-password', '-h', '127.0.0.1', '-p', url.port, '-U', decodeURIComponent(url.username), '-d', url.pathname.slice(1), '-A', '-t', '-c', sql],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password), PGCLIENTENCODING: 'UTF8' } },
  )
  if (result.status !== 0) throw new Error(`查询失败：${result.stderr}`)
  return result.stdout
}

const log = (...args) => console.log(...args)

async function main() {
  if (!existsSync(path.join(bundleDir, 'share', 'extension', 'vector.control'))) {
    console.error(`❌ ${bundleDir} 缺少 pgvector，先跑 scripts/prepare-pg-runtime.mjs`)
    process.exit(1)
  }

  // 从空目录开始 —— 复用旧数据目录会让"首次启动"这条路根本没被测到
  rmSync(userDataDir, { recursive: true, force: true })
  mkdirSync(userDataDir, { recursive: true })

  log('\n=== 1. 首次启动：initdb → 建库 → 迁移 ===')
  const first = await resolveDatabase({ env: {}, bundleDir, migrationsDir, log })
  check(first.mode === 'embedded', `走的是内置库（mode=${first.mode}）`)

  const fp = fingerprint(first.databaseUrl, path.join(first.pgHome, 'bin'))
  for (const [key, expected] of Object.entries(BASELINE)) {
    check(fp[key] === expected, `${key}: ${fp[key]}（基准 ${expected}）`)
  }

  // 本机身份：空库里没有用户和 PAT，接口就全是 401 —— 桌面版能开窗但一张画布都建不了
  const tokenFile = path.join(userDataDir, 'local-token.json')
  const token = existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile, 'utf8')).token : null
  check(typeof token === 'string' && token.startsWith('sg_pat_'), `已签发本机 token（${token ? token.slice(0, 12) + '…' : '缺失'}）`)
  const hash = createHash('sha256').update(token ?? '', 'utf8').digest('hex')
  const tokenRow = query(
    first.databaseUrl,
    path.join(first.pgHome, 'bin'),
    `SELECT "tokenHash", array_length(scopes, 1) FROM "PersonalAccessToken" WHERE "revokedAt" IS NULL`,
  )
  check(tokenRow.trim() === `${hash}|4`, `库内 token 的 sha256 与文件一致，且 scope 为 4 项（实际 ${tokenRow.trim().slice(0, 12)}…）`)

  const rows1 = migrationRows(first.databaseUrl, path.join(first.pgHome, 'bin'))
  check(rows1.finished === 7 && rows1.total === 7, `迁移记账：${rows1.finished}/${rows1.total} 已完成`)

  await first.stop()
  log('  内置库已停止')

  log('\n=== 2. 第二次启动：不得重复执行迁移 ===')
  const second = await resolveDatabase({ env: {}, bundleDir, migrationsDir, log })
  const tokenAfter = existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile, 'utf8')).token : null
  check(tokenAfter === token, '第二次启动复用同一枚 token（没有重复签发）')
  const activeCount = query(
    second.databaseUrl,
    path.join(second.pgHome, 'bin'),
    `SELECT count(*) FROM "PersonalAccessToken" WHERE "revokedAt" IS NULL`,
  ).trim()
  check(activeCount === '1', `有效 token 只有 1 枚（实际 ${activeCount}）`)

  const rows2 = migrationRows(second.databaseUrl, path.join(second.pgHome, 'bin'))
  check(rows2.finished === 7 && rows2.total === 7, `迁移记账仍是 ${rows2.finished}/${rows2.total}，没有重复登记`)
  const fp2 = fingerprint(second.databaseUrl, path.join(second.pgHome, 'bin'))
  check(JSON.stringify(fp2) === JSON.stringify(fp), '结构与首次启动后完全一致')
  await second.stop()

  log('\n=== 3. 迁移文件被改动：校验和必须报错 ===')
  const tamperedDir = path.join(userDataDir, 'tampered-migrations')
  cpSync(migrationsDir, tamperedDir, { recursive: true })
  const lastMigration = readFileSync(path.join(tamperedDir, '20261120000100_card_review_decision', 'migration.sql'), 'utf8')
  writeFileSync(path.join(tamperedDir, '20261120000100_card_review_decision', 'migration.sql'), `${lastMigration}\n-- tampered\n`)
  let tamperMessage = ''
  try {
    const third = await resolveDatabase({ env: {}, bundleDir, migrationsDir: tamperedDir, log: () => {} })
    await third.stop()
  } catch (error) {
    tamperMessage = error instanceof Error ? error.message : String(error)
  }
  check(/校验和/.test(tamperMessage), `改过的迁移被拒绝：${tamperMessage.split('\n')[0] || '(没有报错)'}`)

  log('\n=== 汇总 ===')
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} 项未通过`)
    process.exit(1)
  }
  console.log('✅ 全部通过')
}

main().catch((error) => {
  console.error('❌ 验收脚本自身出错：', error)
  process.exit(1)
})
