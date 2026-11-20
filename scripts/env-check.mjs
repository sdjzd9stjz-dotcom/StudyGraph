// 环境自检（SG-SUP-012 §4.2 第一步）。任何一项 NOT OK → 非 0 退出。
// 全部外部调用都带超时：Docker 管道挂死时不能把整个脚本拖住。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SHA = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 16)

function run(cmd, args, timeout = 8000) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout })
  if (result.error) return { ok: false, out: result.error.code ?? String(result.error) }
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

const report = {}

// 1. Docker 引擎
const engine = run('docker', ['version', '--format', '{{.Server.Version}}'])
report['docker engine'] = engine.ok ? `OK (${engine.out.split('\n').pop()})` : 'UNREACHABLE'

// 2. Postgres
if (engine.ok) {
  const pg = run('docker', ['exec', 'studygraph-postgres', 'psql', '-U', 'studygraph', '-d', 'studygraph', '-tA', '-c', 'select version() || \' | pgvector \' || (select extversion from pg_extension where extname=\'vector\')'])
  report.postgres = pg.ok ? `OK (${pg.out.slice(0, 60)})` : 'DOWN'
} else {
  report.postgres = 'DOWN'
}

// 3. Redis
if (engine.ok) {
  const redis = run('docker', ['exec', 'studygraph-redis', 'redis-cli', 'ping'])
  report.redis = redis.ok && redis.out.includes('PONG') ? 'OK' : 'DOWN'
} else {
  report.redis = 'DOWN'
}

// 4. S3（SeaweedFS 的 S3 网关）
try {
  const response = await fetch('http://127.0.0.1:9000/', { signal: AbortSignal.timeout(5000) })
  report.s3 = response.status < 500 ? `OK (SeaweedFS, HTTP ${response.status})` : `DOWN (HTTP ${response.status})`
} catch {
  report.s3 = 'DOWN'
}

// 5. DeepSeek key（只报有无，绝不打印值）
const key = process.env.DEEPSEEK_API_KEY
report['deepseek key'] = key && key.trim().length > 0 ? 'PRESENT' : 'MISSING'

// 6. DeepSeek 探活（只打状态码）
if (report['deepseek key'] === 'PRESENT') {
  try {
    const response = await fetch('https://api.deepseek.com/models', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    })
    report['deepseek probe'] = String(response.status)
  } catch {
    report['deepseek probe'] = 'TIMEOUT'
  }
} else {
  report['deepseek probe'] = 'SKIP (no key)'
}

const width = Math.max(...Object.keys(report).map((k) => k.length))
for (const [name, value] of Object.entries(report)) {
  console.log(`${name.padEnd(width)} : ${value}`)
}
console.log(`\nenv-check sha256 ${SHA}`)

const ready =
  report['docker engine'].startsWith('OK') &&
  report.postgres.startsWith('OK') &&
  report.redis === 'OK' &&
  report.s3.startsWith('OK') &&
  report['deepseek key'] === 'PRESENT' &&
  report['deepseek probe'] === '200'

if (!ready) {
  console.error('\n❌ 环境未就绪：后续步骤不执行')
  process.exit(1)
}
console.log('\n✅ 环境就绪')
