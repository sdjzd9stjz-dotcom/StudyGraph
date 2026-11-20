// 011 全量复验（SG-SUP-012 §4.2 第二步）。
//
// 12 项按顺序跑，每项独立记 PASS / FAIL / SKIP；**SKIP 不算通过**，有任一非 PASS 就非 0 退出。
// 输出同时落到 tmp/verify-011-<时间戳>.log，报告直接引用该文件。
// 脚本末尾打印自身 sha256，验收方可以据此确认"跑的就是这份脚本"。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const SHA = createHash('sha256').update(readFileSync(SELF)).digest('hex')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const LOG = `tmp/verify-011-${stamp}.log`

const lines = []
function log(line = '') {
  lines.push(line)
  console.log(line)
}

function psql(sql, timeout = 15000) {
  const result = spawnSync(
    'docker',
    ['exec', '-i', 'studygraph-postgres', 'psql', '-U', 'studygraph', '-d', 'studygraph', '-tA', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', timeout },
  )
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(), status: result.status }
}

const results = []
function record(index, title, status, detail = '') {
  results.push({ index, title, status, detail })
  const suffix = detail ? `  ${detail.split('\n')[0].slice(0, 100)}` : ''
  log(`[${index}/12] ${title.padEnd(26)} ${status}${suffix}`)
}

// ── 步骤实现（环境通了才会被调用）──────────────────────────────────────────
const steps = [
  {
    title: '迁移·空库',
    run: () => {
      const r = psql('select 1;')
      return r.ok ? ['PASS', 'psql 可连接'] : ['FAIL', r.out]
    },
  },
  { title: '迁移·老库', run: () => ['SKIP', '需要在空库上重放 init+guards 两条历史迁移，脚本待环境就绪后补执行器'] },
  {
    title: '写库实验 a/b/c/d',
    run: () => ['SKIP', '需要真实事务夹具（Concept/Problem 各两例），脚本待环境就绪后补执行器'],
  },
  { title: '降级 Concept→UNVER', run: () => ['SKIP', '依赖写库实验夹具'] },
  { title: '降级 Problem→PENDING', run: () => ['SKIP', '依赖写库实验夹具'] },
  {
    title: '视图 0 行',
    run: () => {
      const r = psql('select count(*) from "v_verified_without_citation";')
      return r.ok ? [r.out === '0' ? 'PASS' : 'FAIL', `count=${r.out}`] : ['FAIL', r.out]
    },
  },
  { title: 'CARD 链路·标题 0 张', run: () => ['SKIP', '需要模型 key 与已建画布'] },
  { title: '巡检 A–F 落库', run: () => ['SKIP', '需要写库夹具'] },
  { title: '复核四条 curl', run: () => ['SKIP', '需要运行中的 API 与登录态'] },
  { title: '校准表', run: () => ['SKIP', '需要新批次产物（含 spanText 快照）'] },
  { title: '负例 错页/无关', run: () => ['SKIP', '依赖校准批次'] },
  { title: '真实产出统计', run: () => ['SKIP', '需要新画布产出'] },
]

log(`verify-011 ${stamp}`)
log(`script sha256 ${SHA}`)
log('')

// 环境先行：不通就全 SKIP，并且非 0 退出
const env = spawnSync(process.execPath, ['scripts/env-check.mjs'], { encoding: 'utf8', timeout: 60000 })
const envOk = env.status === 0
log('── env-check ──')
log((env.stdout ?? '').trim())
if (env.stderr) log((env.stderr ?? '').trim())
log('')

steps.forEach((step, index) => {
  if (!envOk) {
    record(index + 1, step.title, 'SKIP', '环境未就绪（env-check 非 0）')
    return
  }
  try {
    const [status, detail] = step.run()
    record(index + 1, step.title, status, detail)
  } catch (error) {
    record(index + 1, step.title, 'FAIL', error instanceof Error ? error.message : String(error))
  }
})

const pass = results.filter((r) => r.status === 'PASS').length
const fail = results.filter((r) => r.status === 'FAIL').length
const skip = results.filter((r) => r.status === 'SKIP').length

log('')
log(`汇总: PASS ${pass} / FAIL ${fail} / SKIP ${skip} / 共 ${results.length}`)
log(`script sha256 ${SHA}`)

writeFileSync(LOG, lines.join('\n') + '\n')
console.log(`\n日志已写入 ${LOG}`)

process.exit(fail > 0 || skip > 0 ? 1 : 0)
