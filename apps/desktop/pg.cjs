// 内置 PostgreSQL 生命周期（StudyGraph 桌面版）
//
// 桌面包里带一份官方 PostgreSQL 16（EDB Windows x64 二进制）+ 自编译 pgvector。
// 本模块负责：首次 initdb → 建库 → 跑迁移 → 起服务 → 给出 DATABASE_URL → 退出时收干净。
//
// 每条设计都对应一个真实的失败模式，别"优化"掉：
//   · 端口每次启动重新分配 —— 学生机器上 5432 常被本机 Docker 占着，写死就是启动失败
//   · 密码在 initdb 时随机生成并落盘 —— 127.0.0.1 上开 trust，等于把学习数据对任意本机进程敞开
//   · 迁移自己记账，且表结构照抄 prisma 的 _prisma_migrations —— 以后用 prisma migrate deploy
//     接管这个库时，它会认为这些迁移已应用，不会重复建表
//   · 退出必须 pg_ctl stop —— 否则残留的 postmaster.pid 会让下次启动报"另一个服务器可能在运行"
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const IS_WIN = process.platform === 'win32'

function pgBin(pgHome, name) {
  return path.join(pgHome, 'bin', name + (IS_WIN ? '.exe' : ''))
}

/** 让系统分配一个空闲端口再释放，避免"探测后被抢占"的竞态 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function run(exe, args, options = {}) {
  const result = spawnSync(exe, args, {
    encoding: options.stdio === 'ignore' ? undefined : 'utf8',
    // pg_ctl start 会派生 postgres，后者继承 pg_ctl 的 stdout；
    // 若这里捕获管道，spawnSync 会一直等管道关闭 —— 数据库在跑，管道就永远不关，进程名存实亡地卡死。
    // 启动这一步因此用 'ignore'，失败信息从 -l 指定的日志文件里读。
    stdio: options.stdio ?? 'pipe',
    windowsHide: true,
    timeout: options.timeoutMs ?? 120000,
    env: { ...process.env, ...options.env },
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

/** psql 统一入口：永远带 -X（不读用户 psqlrc，否则别人机器上的配置能改行为） */
function psql(ctx, args, options = {}) {
  return run(
    ctx.psqlPath,
    ['-X', '--no-password', '-h', '127.0.0.1', '-p', String(ctx.port), '-U', ctx.user, ...args],
    { ...options, env: { PGPASSWORD: ctx.password, PGCLIENTENCODING: 'UTF8', ...(options.env ?? {}) } },
  )
}

/**
 * 用 -f 文件执行 SQL。
 *
 * 为什么不用 -c：Windows 在把命令行参数交给子进程时会按系统 ANSI 代码页（中文机器是 GBK）
 * 转码，SQL 里一旦有中文就会变成 `invalid byte sequence for encoding "UTF8": 0xb1`。
 * 迁移之所以一直没踩到，正是因为它走的是 -f 读文件（文件字节原样是 UTF-8）。
 */
function psqlFile(ctx, sql, what, dir) {
  const file = path.join(dir, `.sql-${crypto.randomUUID()}.sql`)
  fs.writeFileSync(file, sql, 'utf8')
  try {
    // -A -t：无对齐、无表头、无行尾填充。少了它们，取回来的 id 会带表格边框和表头。
    return psql(ctx, ['-d', ctx.database, '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-t', '-f', file])
  } finally {
    fs.rmSync(file, { force: true })
  }
}

function must(result, what) {
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || (result.error && result.error.message) || '').trim()
    throw new Error(`${what}失败（exit ${result.status}）：\n${detail.slice(-3000)}`)
  }
  return result
}

/**
 * PostgreSQL 的 Windows 二进制在含非 ASCII 字符的路径下会直接失败，而且报错完全不相干：
 *   · 二进制放在中文目录 → initdb: could not create directory ...: Permission denied
 *   · 数据目录放在中文目录 → initdb: FATAL: invalid byte sequence for encoding "UTF8": 0xb8
 * 两个 initdb.exe 的 sha256 完全相同，换到 C:\tmp 下就能跑通 —— 所以这是路径问题，不是文件问题。
 * 结论：运行时与数据目录都必须落在纯 ASCII 路径上，这条不能"优化"掉。
 */
function isAsciiPath(value) {
  return /^[\x20-\x7E]+$/.test(value)
}

function isWritableDir(dir) {
  const probe = path.join(dir, `.probe-${process.pid}`)
  try {
    fs.mkdirSync(probe)
    fs.rmdirSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * 找一个 ASCII 且可写的数据根基目录。
 * 候选链覆盖中文 Windows：用户名是中文时 %LOCALAPPDATA% 本身就是非 ASCII 的。
 */
/**
 * 把"这次到底用了哪个数据目录"记下来。
 *
 * 为什么需要：数据目录有三档回退（%LOCALAPPDATA% → %ProgramData% → 系统盘根），
 * 用户名是中文时会落到后两档。卸载程序只能猜到第一档，于是"保留数据"那一步
 * 对着一个不存在的路径做完检查就结束了 —— 用户以为保留了，实际数据在别处，
 * 下次安装会重新 initdb，看起来就是"数据丢了"。
 *
 * 记录位置固定用 %LOCALAPPDATA%StudyGraph-data-dir.txt（LOCALAPPDATA 本身
 * 非 ASCII 时退到 InstallationDir）：卸载程序只读这一个文件，不猜。
 */
function recordDataDir(base, log) {
  const anchor = process.env.LOCALAPPDATA || path.dirname(process.execPath)
  fs.mkdirSync(anchor, { recursive: true })
  const target = path.join(anchor, 'StudyGraph-data-dir.txt')
  try {
    fs.writeFileSync(target, base + String.fromCharCode(10), 'utf8')
  } catch (error) {
    log('写入数据目录标记失败：', error instanceof Error ? error.message : String(error))
  }
  // 机器级备份：用户级目录被删也能从这里找回真实位置
  try {
    const installDir = path.dirname(process.execPath)
    if (isAsciiPath(installDir)) fs.writeFileSync(path.join(installDir, 'data-dir.txt'), base + String.fromCharCode(10), 'utf8')
  } catch {
    // 安装目录不可写（Program Files）就算了，用户级那份才是主记录
  }
  return target
}

function resolveAsciiBase(log) {
  // 显式指定优先（用户换数据盘、或验收脚本指定隔离目录）
  if (process.env.STUDYGRAPH_DATA_DIR) {
    const explicit = path.resolve(process.env.STUDYGRAPH_DATA_DIR)
    if (!isAsciiPath(explicit)) {
      throw new Error(`STUDYGRAPH_DATA_DIR 必须是纯英文路径，当前为：${explicit}\nPostgreSQL 在含中文的路径下无法运行。`)
    }
    fs.mkdirSync(explicit, { recursive: true })
    return explicit
  }

  const candidates = [
    process.env.LOCALAPPDATA,
    process.env.ProgramData,
    `${process.env.SystemDrive || 'C:'}\\`,
  ]
  for (const parent of candidates) {
    if (!parent) continue
    const base = path.join(parent, 'StudyGraph')
    if (!isAsciiPath(base)) {
      log(`跳过非 ASCII 路径：${base}`)
      continue
    }
    try {
      fs.mkdirSync(base, { recursive: true })
    } catch {
      continue
    }
    if (isWritableDir(base)) return base
    log(`不可写，跳过：${base}`)
  }
  throw new Error(
    '找不到可用的纯英文（ASCII）数据目录。PostgreSQL 在含中文的路径下无法运行。\n' +
      '请把 Windows 用户名或数据盘路径改为英文，或手动创建 C:\\StudyGraph 并授予当前用户写权限。',
  )
}

/**
 * 拿到一个 ASCII 路径可直接运行的运行时目录。
 * 安装目录本身是 ASCII 时就地使用（省一次 66MB 复制）；否则释放到数据根目录下。
 * 用 PG-BUNDLE.json 的版本+关键文件哈希做标记，内置运行时换了版本会自动重新释放。
 */
function ensureRuntimeDir(bundleDir, base, log) {
  const bundleManifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'PG-BUNDLE.json'), 'utf8'))
  const bundleKey = `${bundleManifest.postgres}|${bundleManifest.files['lib/vector.dll'].slice(0, 16)}`

  if (isAsciiPath(bundleDir) && fs.existsSync(path.join(bundleDir, 'bin', 'pg_ctl.exe'))) {
    return bundleDir
  }

  const runtimeDir = path.join(base, 'runtime')
  const markerFile = path.join(runtimeDir, '.bundle-key')
  const usable = fs.existsSync(markerFile) && fs.readFileSync(markerFile, 'utf8').trim() === bundleKey && fs.existsSync(path.join(runtimeDir, 'bin', 'pg_ctl.exe'))
  if (usable) return runtimeDir

  log('安装路径含非 ASCII 字符，正在释放数据库运行时 →', runtimeDir)
  // 重新释放：先删干净，避免新旧文件混在一起（旧版本残留的 dll 会被优先加载）
  fs.rmSync(runtimeDir, { recursive: true, force: true })
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.cpSync(bundleDir, runtimeDir, { recursive: true })
  fs.writeFileSync(markerFile, `${bundleKey}\n`)
  log('运行时释放完成')
  return runtimeDir
}

const LOCAL_USER_EMAIL = 'desktop@studygraph.local'
const LOCAL_TOKEN_NAME = 'desktop-local'
const LOCAL_TOKEN_SCOPES = ['CANVAS_READ', 'CANVAS_WRITE', 'RUN_EXECUTE', 'PROBLEM_READ']

/**
 * 首次启动自建本地身份。
 *
 * 为什么必须有这一步：接口一律要求 `Authorization: Bearer sg_pat_...`，
 * 而空的内置库里没有任何用户和 token —— 不建身份，桌面版能开窗但一张画布都建不了（全是 401）。
 *
 * 明文 token 只落在本机文件（0600）并注入进程环境变量，库里只存 sha256，
 * 与手写脚本 scripts/seed-pat.ts 的口径一致。
 */
function ensureLocalIdentity(ctx, base, log) {
  const tokenFile = path.join(base, 'local-token.json')
  const existing = (() => {
    try {
      return JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
    } catch {
      return null
    }
  })()

  // 文件在、且库里这枚 token 仍然有效 → 直接复用（每次都新建会让 token 表无限增长）
  if (existing && typeof existing.token === 'string' && existing.token.startsWith('sg_pat_')) {
    const hash = crypto.createHash('sha256').update(existing.token, 'utf8').digest('hex')
    const check = psql(ctx, [
      '-d', ctx.database, '-A', '-t', '-c',
      `SELECT 1 FROM "PersonalAccessToken" WHERE "tokenHash" = '${hash}' AND "revokedAt" IS NULL`,
    ])
    if (check.status === 0 && check.stdout.trim() === '1') return existing.token
    log('本地 token 已失效，重新签发')
  }

  const userId = crypto.randomUUID()
  const token = `sg_pat_${crypto.randomBytes(32).toString('base64url')}`
  const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex')
  const tokenPrefix = token.slice('sg_pat_'.length, 'sg_pat_'.length + 8)
  const scopesSql = `ARRAY['${LOCAL_TOKEN_SCOPES.join("','")}']::"Scope"[]`

  // 用户按 email 复用；token 每次新签，旧的同一用途 token 一并吊销
  const userRow = must(
    psqlFile(
      ctx,
      `WITH upsert AS (
         INSERT INTO "User" (id, email, "displayName", "updatedAt")
         VALUES ('${userId}', '${LOCAL_USER_EMAIL}', '本机用户', now())
         ON CONFLICT (email) DO UPDATE SET "updatedAt" = now()
         RETURNING id
       ) SELECT id FROM upsert;`,
      '创建本地用户',
      base,
    ),
    '创建本地用户',
  )
  const resolvedUserId = userRow.stdout.trim()

  must(
    psqlFile(
      ctx,
      `UPDATE "PersonalAccessToken" SET "revokedAt" = now()
       WHERE "userId" = '${resolvedUserId}' AND name = '${LOCAL_TOKEN_NAME}' AND "revokedAt" IS NULL;`,
      '吊销旧的本地 token',
      base,
    ),
    '吊销旧的本地 token',
  )

  must(
    psqlFile(
      ctx,
      `INSERT INTO "PersonalAccessToken" (id, "userId", name, "tokenPrefix", "tokenHash", scopes)
       VALUES ('${crypto.randomUUID()}', '${resolvedUserId}', '${LOCAL_TOKEN_NAME}', '${tokenPrefix}', '${tokenHash}', ${scopesSql});`,
      '签发本地 token',
      base,
    ),
    '签发本地 token',
  )

  fs.writeFileSync(tokenFile, `${JSON.stringify({ token, userId: resolvedUserId, email: LOCAL_USER_EMAIL }, null, 2)}\n`, { mode: 0o600 })
  log('已签发本机 token：', tokenFile)
  return token
}

function readCredentials(file) {
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed.user === 'string' && typeof parsed.password === 'string') return parsed
  } catch {
    // 文件损坏：当作没有，走重建凭证流程（数据目录还在，密码不会变）
  }
  return null
}

/**
 * 凭证文件丢了但数据目录还在 —— 密码无法从库里读出来，只能改。
 * 走单用户模式重置，比"让用户删掉数据重来"温和得多。
 */
function resetPasswordViaSingleUser(pgHome, dataDir, user, password) {
  // 单用户模式从 stdin 读 SQL，而 run() 不传 stdin，这里单独发一次
  const reset = spawnSync(pgBin(pgHome, 'postgres'), ['--single', '-D', dataDir, '-U', user, 'postgres'], {
    encoding: 'utf8',
    input: `ALTER USER "${user}" PASSWORD '${password.replace(/'/g, "''")}';\n`,
    timeout: 60000,
    windowsHide: true,
  })
  if (reset.status !== 0) {
    throw new Error(`单用户模式重置密码失败：\n${(reset.stderr || reset.stdout || '').slice(-2000)}`)
  }
}

function ensureCluster(pgHome, dataDir, credentialsFile, user, log) {
  const dataExists = fs.existsSync(path.join(dataDir, 'PG_VERSION'))
  let credentials = readCredentials(credentialsFile)

  if (!credentials) {
    credentials = { user, password: crypto.randomBytes(24).toString('base64url') }
    fs.mkdirSync(path.dirname(credentialsFile), { recursive: true })
    fs.writeFileSync(credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
    log('已生成内置库凭证：', credentialsFile)
  }

  if (dataExists) {
    if (readCredentials(credentialsFile) === null) resetPasswordViaSingleUser(pgHome, dataDir, user, credentials.password)
    return credentials
  }

  fs.mkdirSync(path.dirname(dataDir), { recursive: true })
  const pwFile = path.join(path.dirname(dataDir), 'initdb.pw')
  fs.writeFileSync(pwFile, credentials.password, { mode: 0o600 })
  try {
    // --locale=C：collation 与机器区域设置无关，否则同一份数据在中文/英文 Windows 上排序不同
    must(
      run(pgBin(pgHome, 'initdb'), [
        '-D', dataDir,
        '-U', credentials.user,
        `--pwfile=${pwFile}`,
        '--auth-local=scram-sha-256',
        '--auth-host=scram-sha-256',
        '-E', 'UTF8',
        '--locale=C',
      ]),
      'initdb',
    )
  } finally {
    fs.rmSync(pwFile, { force: true })
  }
  log('内置库已初始化：', dataDir)
  return credentials
}

function clearStalePidFile(pgHome, dataDir) {
  const pidFile = path.join(dataDir, 'postmaster.pid')
  if (!fs.existsSync(pidFile)) return
  const status = run(pgBin(pgHome, 'pg_ctl'), ['-D', dataDir, 'status'])
  if (status.status === 0) {
    // 上一次没退干净（应用被强杀），先停掉再按新端口起
    run(pgBin(pgHome, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', '-t', '60', 'stop'])
    return
  }
  fs.rmSync(pidFile, { force: true })
}

/**
 * 清理上次崩溃留下的共享内存残留。
 *
 * 症状（用户实际遇到）：应用被强杀或崩溃后，下次启动报
 *   FATAL: pre-existing shared memory block is still in use
 *   HINT: Check if there are any old server processes still running
 * 这不是数据损坏，只是旧的 postgres 进程还攥着 Windows 的共享内存段。
 *
 * 做法：把命令行里带本数据目录的 postgres 进程全部结束，再删掉 postmaster.pid。
 * 只杀"指向我们这个 DataDir 的"，绝不碰用户自己装的 PostgreSQL 或 Docker 里的实例。
 */
function recoverSharedMemory(pgHome, dataDir, log) {
  let killed = 0
  if (IS_WIN) {
    // 单引号包裹路径：PowerShell 里反斜杠不需要转义。
    // 语句之间**必须用分号分隔** —— 用空格拼在一起会变成语法错误，
    // 结果是清理永远失败、且不报错（实测踩过）。
    // 关键：`Get-CimInstance … | Where-Object …` 必须是**同一个数组元素**。
    // 拆成两个元素再用 '; ' 连接，分号会把管道切断，整个脚本语法错误、
    // 清理永远失效且不报错（实测踩过两次）。
    const script = [
      `$target = '${dataDir.replace(/'/g, "''")}'`,
      `$procs = @(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($target) })`,
      `foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output $p.ProcessId }`,
    ].join('; ')
    const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    killed = String(result.stdout ?? '').split(/\r?\n/).filter((line) => line.trim()).length
    if (result.status !== 0) log('清理残留进程时返回非 0：', String(result.stderr ?? '').slice(0, 200))
  } else {
    const result = spawnSync('pkill', ['-f', dataDir], { encoding: 'utf8' })
    if (result.status === 0) killed = 1
  }

  fs.rmSync(path.join(dataDir, 'postmaster.pid'), { force: true })
  if (killed > 0) log(`已清理 ${killed} 个残留的数据库进程`)
  return killed
}

function listMigrations(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) throw new Error(`迁移目录不存在：${migrationsDir}`)
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const file = path.join(migrationsDir, name, 'migration.sql')
      if (!fs.existsSync(file)) throw new Error(`迁移 ${name} 缺少 migration.sql`)
      return { name, file, sql: fs.readFileSync(file) }
    })
}

const PRISMA_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) NOT NULL PRIMARY KEY,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);`

/**
 * 应用迁移。
 * 校验和用 sha256(migration.sql 原始字节)，与 prisma 的算法一致 ——
 * 这条是"删掉它会漏什么"的典型：没有校验和，改动一份已应用的迁移不会有人发现，
 * 新旧库结构悄悄分叉。
 */
function applyMigrations(ctx, migrationsDir, log) {
  must(psql(ctx, ['-d', ctx.database, '-v', 'ON_ERROR_STOP=1', '-q', '-c', PRISMA_MIGRATIONS_TABLE]), '创建 _prisma_migrations')

  const appliedResult = must(
    psql(ctx, [
      '-d', ctx.database, '-A', '-t', '-F', '|', '-c',
      `SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    ]),
    '读取已应用迁移',
  )
  const applied = new Map(
    appliedResult.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, checksum] = line.split('|')
        return [name, checksum]
      }),
  )

  let count = 0
  for (const migration of listMigrations(migrationsDir)) {
    const checksum = crypto.createHash('sha256').update(migration.sql).digest('hex')
    const already = applied.get(migration.name)
    if (already !== undefined) {
      if (already !== checksum) {
        throw new Error(
          `迁移 ${migration.name} 的校验和与库内记录不一致：\n  库内 ${already}\n  文件 ${checksum}\n` +
            '说明这份迁移被改动过。已应用过的迁移不能再改，请新加一份迁移。',
        )
      }
      continue
    }

    // 同一个 psql 连接、同一事务；进程中断时不会只留下表而没有完成记录。
    const name = migration.name.replaceAll("'", "''")
    must(psql(ctx, ['-d', ctx.database, '-1', '-v', 'ON_ERROR_STOP=1', '-q', '-f', migration.file, '-c',
      `INSERT INTO "_prisma_migrations" (id,checksum,migration_name,started_at,finished_at,applied_steps_count) VALUES ('${crypto.randomUUID()}','${checksum}','${name}',now(),now(),1)`,
    ]), `应用迁移 ${migration.name}`)
    count += 1
    log('迁移已应用：', migration.name)
  }
  log(count === 0 ? '迁移已是最新（0 份待应用）' : `迁移完成：${count} 份`)
}

function ensureDatabase(ctx, log) {
  const exists = must(
    psql(ctx, ['-d', 'postgres', '-A', '-t', '-c', `SELECT 1 FROM pg_database WHERE datname = '${ctx.database}'`]),
    '检查数据库是否存在',
  )
  if (exists.stdout.trim() === '1') return
  must(psql(ctx, ['-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-c', `CREATE DATABASE "${ctx.database}"`]), '建库')
  log('已创建数据库：', ctx.database)
}

async function waitForReady(ctx, timeoutMs = 60000) {
  const started = Date.now()
  let last = ''
  while (Date.now() - started < timeoutMs) {
    const check = run(pgBin(ctx.pgHome, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(ctx.port), '-U', ctx.user])
    if (check.status === 0) return
    last = (check.stdout || check.stderr || '').trim()
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`内置库 ${timeoutMs}ms 内未就绪：${last}`)
}

/**
 * 拿到可用的 DATABASE_URL。
 * 显式配置了 DATABASE_URL 就用它（开发/连外部库的场景），否则拉起内置库。
 */
async function resolveDatabase({ env, bundleDir, migrationsDir, log }) {
  if (env.DATABASE_URL) {
    log('使用外部 DATABASE_URL（跳过内置库）')
    return { databaseUrl: env.DATABASE_URL, mode: 'external', stop: async () => {} }
  }

  const bundlePkg = path.join(bundleDir, 'PG-BUNDLE.json')
  if (!fs.existsSync(path.join(bundleDir, 'bin', 'pg_ctl.exe'))) {
    throw new Error(`内置 PostgreSQL 不完整：找不到 ${path.join(bundleDir, 'bin', 'pg_ctl.exe')}`)
  }
  if (!fs.existsSync(bundlePkg)) {
    throw new Error(`内置 PostgreSQL 缺少清单 ${bundlePkg}，请重新运行 scripts/prepare-pg-runtime.mjs`)
  }

  const base = resolveAsciiBase(log)
  recordDataDir(base, log)
  const pgHome = ensureRuntimeDir(bundleDir, base, log)

  const vectorControl = path.join(pgHome, 'share', 'extension', 'vector.control')
  if (!fs.existsSync(vectorControl)) {
    throw new Error(
      `内置 PostgreSQL 缺少 pgvector（${vectorControl} 不存在）。\n` +
        '迁移里的 CREATE EXTENSION "vector" 会直接失败，概念卡的向量字段无法建立。',
    )
  }

  // 数据目录同样必须在 ASCII 路径下：initdb 在中文路径里会报
  // FATAL: invalid byte sequence for encoding "UTF8"
  const dataDir = path.join(base, 'pgdata')
  const credentialsFile = path.join(base, 'pg-credentials.json')
  const user = 'studygraph'
  const database = 'studygraph'

  const credentials = ensureCluster(pgHome, dataDir, credentialsFile, user, log)

  clearStalePidFile(pgHome, dataDir)

  const port = await freePort()
  const logFile = path.join(base, 'postgres.log')

  const tryStart = () =>
    run(
      pgBin(pgHome, 'pg_ctl'),
      ['-D', dataDir, '-l', logFile, '-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-w', '-t', '60', 'start'],
      { stdio: 'ignore', timeoutMs: 90000 },
    )

  const readLogTail = () =>
    fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).slice(-15).join('\n') : '(无日志)'

  let started = tryStart()

  // 上一次崩溃留下的共享内存残留：清理后重试一次。
  // 用户实际遇到的就是这个（FATAL: pre-existing shared memory block is still in use），
  // 不自动恢复的话，软件从此再也打不开，只能手动删目录 —— 那是不可接受的。
  if (started.status !== 0) {
    const tail = readLogTail()
    if (/pre-existing shared memory|another postmaster|lock file .* already exists/i.test(tail)) {
      log('检测到上次崩溃残留，正在清理后重试…')
      recoverSharedMemory(pgHome, dataDir, log)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      clearStalePidFile(pgHome, dataDir)
      started = tryStart()
    }
  }

  if (started.status !== 0) {
    throw new Error(`启动内置库失败（exit ${started.status}）。\npostgres 日志末尾：\n${readLogTail()}`)
  }
  log(`内置库已启动 :${port}`)

  const ctx = {
    pgHome,
    port,
    user: credentials.user,
    password: credentials.password,
    database,
    psqlPath: pgBin(pgHome, 'psql'),
  }

  let localToken = null

  const stopServer = () => {
    const result = run(pgBin(pgHome, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', '-t', '60', 'stop'], {
      timeoutMs: 70000,
    })
    return result
  }

  // 建库/迁移失败时必须把刚起的 postgres 收掉。
  // 不然它会一直占着数据目录，用户再次打开时看到的是"Permission denied"这种毫不相干的报错，
  // 这一条是实测踩出来的：验收脚本第 3 步失败后，pgdata 被锁死，连删都删不掉。
  try {
    await waitForReady(ctx)
    ensureDatabase(ctx, log)
    applyMigrations(ctx, migrationsDir, log)
    localToken = ensureLocalIdentity(ctx, base, log)
  } catch (error) {
    log('启动流程失败，正在停止内置库以免目录被占用')
    stopServer()
    throw error
  }

  const url = `postgresql://${encodeURIComponent(ctx.user)}:${encodeURIComponent(ctx.password)}@127.0.0.1:${port}/${database}?schema=public`

  return {
    databaseUrl: url,
    mode: 'embedded',
    port,
    pgHome,
    baseDir: base,
    dataDir,
    localToken,
    // 退出时同步停库：异步的话进程先退，postgres 变孤儿，下次启动要处理残留 pid
    stop: async () => {
      const result = run(pgBin(pgHome, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', '-t', '60', 'stop'], {
        timeoutMs: 70000,
      })
      if (result.status !== 0) log('内置库停止时返回非 0：', (result.stderr || result.stdout).trim().slice(-500))
      else log('内置库已停止')
    },
  }
}

module.exports = { resolveDatabase, freePort }
