// 从官方 EDB PostgreSQL 16 Windows 二进制目录，裁剪出可打包的运行时 → vendor/pg16
//
// 为什么裁剪：完整解压目录 836MB，其中 pgAdmin 4 就 692MB —— 它和桌面版毫无关系。
// 裁完约 60–70MB（bin 去掉 wx* / stackbuilder，lib 去掉 .lib 导入库，share 去掉 locale 翻译）。
//
// 用法：node scripts/prepare-pg-runtime.mjs [源目录]
//   源目录默认取环境变量 STUDYGRAPH_PG_SOURCE，否则 C:/tmp/pgstage/pgsql
//
// pgvector 是硬性前置：迁移里 CREATE EXTENSION "vector" 一句，缺了整条建表链就断在第 8 行。
// 这里不做"缺了也能过"的降级 —— 那种降级只会在用户机器上变成启动失败。
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const source = path.resolve(process.argv[2] ?? process.env.STUDYGRAPH_PG_SOURCE ?? 'C:/tmp/pgstage/pgsql')
const target = path.join(root, 'vendor', 'pg16')

if (!existsSync(path.join(source, 'bin', 'pg_ctl.exe'))) {
  console.error(`❌ 源目录不像 PostgreSQL 二进制目录（缺 bin/pg_ctl.exe）：${source}`)
  process.exit(1)
}

// 逐目录排除清单：只排除确认与运行时无关的
const TOP_LEVEL_SKIP = new Set(['pgAdmin 4', 'StackBuilder', 'doc', 'include', 'pgAdmin4'])
const BIN_SKIP = /^(stackbuilder\.exe|ecpg\.exe|pg_regress.*\.exe|wx.*\.dll)$/i
const LIB_SKIP = /\.(lib|exp)$/i
const SHARE_SKIP = new Set(['locale'])

const log = (...args) => console.log(...args)

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

for (const entry of readdirSync(source)) {
  if (TOP_LEVEL_SKIP.has(entry)) continue
  const from = path.join(source, entry)
  // 顶层普通文件（PG_VERSION 等）必须一并复制：缺 PG_VERSION，initdb 不认这是一个数据目录的前置运行时
  if (!statSync(from).isDirectory()) {
    cpSync(from, path.join(target, entry))
    continue
  }
  cpSync(from, path.join(target, entry), {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(source, src)
      const [top, ...rest] = rel.split(path.sep)
      const name = path.basename(src)
      if (top === 'bin') return !(rest.length === 1 && BIN_SKIP.test(name))
      if (top === 'lib') return !(rest.length === 1 && LIB_SKIP.test(name))
      if (top === 'share') return !(rest.length === 1 && SHARE_SKIP.has(name))
      return true
    },
  })
}

// ── 自带 MSVC 运行库 ──────────────────────────────────────────────────────
// EDB 的 Windows 二进制是动态链接 CRT 的：postgres.exe / psql.exe 都引用 VCRUNTIME140.dll。
// 这台开发机装了 VC++ 运行库所以看不出来，但干净的学生机器上不一定有 ——
// 缺了它，数据库直接起不来，用户看到的是"启动失败"。
// 微软允许随应用分发这几个 DLL，直接放进 bin/ 让 Windows 从同目录加载。
const CRT_PATTERN = /[A-Za-z0-9_.-]*(?:VCRUNTIME140[A-Za-z0-9_]*|MSVCP140[A-Za-z0-9_]*)\.dll/gi
const crtNeeded = new Set()
for (const entry of readdirSync(path.join(target, 'bin'))) {
  if (!/\.(exe|dll)$/i.test(entry)) continue
  const text = readFileSync(path.join(target, 'bin', entry)).toString('latin1')
  for (const match of text.match(CRT_PATTERN) ?? []) crtNeeded.add(match.toLowerCase())
}
const system32 = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32')
for (const dll of crtNeeded) {
  const from = path.join(system32, dll)
  if (!existsSync(from)) {
    console.error(`❌ 需要 ${dll}，但系统里找不到：${from}`)
    console.error('   在装有 VC++ 2015-2022 运行库的机器上重新跑一次本脚本。')
    process.exit(1)
  }
  cpSync(from, path.join(target, 'bin', dll))
}

// ── 校验：缺任何一项都立刻失败，而不是留到用户双击时 ─────────────────────
const required = [
  ['bin/pg_ctl.exe', 'pg_ctl（起停数据库）'],
  ['bin/initdb.exe', 'initdb（首次建库）'],
  ['bin/postgres.exe', 'postgres（数据库本体）'],
  ['bin/psql.exe', 'psql（跑迁移）'],
  ['bin/pg_isready.exe', 'pg_isready（就绪检查）'],
  ['share/postgresql.conf.sample', 'postgresql.conf.sample'],
  ['share/extension/pg_trgm.control', 'pg_trgm 扩展'],
  ['share/extension/vector.control', 'pgvector 扩展（.control）'],
  ['lib/vector.dll', 'pgvector 扩展（Windows 动态库）'],
]
const missing = required.filter(([rel]) => !existsSync(path.join(target, rel)))
if (missing.length > 0) {
  console.error('❌ 运行时缺少必需文件：')
  for (const [rel, what] of missing) console.error(`   · ${rel}  —— ${what}`)
  if (missing.some(([rel]) => rel.includes('vector'))) {
    console.error('\npgvector 需要用 PG16 的头文件在本机编译后放进 lib/ 与 share/extension/，')
    console.error('官方 Windows 二进制包不含它。编译步骤见 docs/桌面-内置数据库构建.md')
  }
  process.exit(1)
}

// ── 清单：把版本与关键文件哈希记下来，升级/排查时能对上号 ────────────────
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const manifest = {
  builtAt: new Date().toISOString(),
  source,
  // 二进制包没有 PG_VERSION（那是 initdb 在数据目录里写的），版本从 pg_config 读
  postgres: spawnSync(path.join(target, 'bin', 'pg_config.exe'), ['--version'], { encoding: 'utf8' }).stdout.trim(),
  files: {
    'bin/postgres.exe': sha256(path.join(target, 'bin', 'postgres.exe')),
    'bin/psql.exe': sha256(path.join(target, 'bin', 'psql.exe')),
    'share/extension/vector.control': sha256(path.join(target, 'share', 'extension', 'vector.control')),
    'lib/vector.dll': sha256(path.join(target, 'lib', 'vector.dll')),
  },
}
writeFileSync(path.join(target, 'PG-BUNDLE.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const sizeOf = (dir) => {
  let total = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else total += statSync(full).size
    }
  }
  walk(dir)
  return total
}

log(`PostgreSQL ${manifest.postgres} 运行时已就绪：${target}`)
log(`体积：${(sizeOf(target) / 1024 / 1024).toFixed(1)} MB`)
log('pgvector：', manifest.files['lib/vector.dll'].slice(0, 16), '…')
