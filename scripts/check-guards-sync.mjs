// 守卫同步校验（SG-SUP-012：覆盖全部 migration，正文逐字比对，双向自测）
//
// 两个曾经让这个校验器「静默通过」的缺陷，2026-11-20 修：
//   1. 切分器按 `;` 切，PL/pgSQL 函数体里的 `RAISE EXCEPTION ...;` 会把 CREATE FUNCTION
//      截断成两半，函数对象被整条丢掉 —— 于是「函数被改回旧版」永远查不出来。
//      现在切分器认 dollar-quote（$$ / $tag$）与单引号字符串，只在语句层级的 ; 处切。
//   2. 只按对象名建 Map，同名后定义静默覆盖先定义。现在把覆盖记进 provenance，
//      由 --self-test 断言「同一对象被重新定义时必须留下痕迹」。
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PATTERN = /^CREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|TRIGGER|VIEW)\s+"?([A-Za-z0-9_]+)"?/i
const root = path.resolve(import.meta.dirname, '..')
const migrationsDir = path.join(root, 'packages/db/prisma/migrations')
const guardsSql = path.join(root, 'packages/db/sql/guards.sql')

// 把 SQL 文本切成语句：忽略 -- 行注释，跳过单引号字符串与 dollar-quoted 块内的 ;
export function splitStatements(sql) {
  const out = []
  let start = 0
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl + 1
      continue
    }
    if (ch === "'") {
      i++
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i] === "'") { i++; break }
        else i++
      }
      continue
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i, i + 64))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        i = close === -1 ? sql.length : close + tag[0].length
        continue
      }
    }
    if (ch === ';') {
      out.push(sql.slice(start, i))
      start = i + 1
    }
    i++
  }
  if (start < sql.length) out.push(sql.slice(start))
  return out
}

const clean = (chunk) =>
  chunk
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^CREATE OR REPLACE /i, 'CREATE ')

// 语句开头的注释行必须先剥掉再匹配：否则「-- 说明\nCREATE TRIGGER ...」这种常见写法
// 会被当成非 CREATE 语句整条跳过（2026-11-20 实测：guards.sql 首条触发器与两个
// PL/pgSQL 函数因此长期隐身，校验器却在报「文件缺少该对象」——方向完全反了）
function stripLeadingComments(statement) {
  let text = statement
  for (;;) {
    const trimmed = text.replace(/^\s+/, '')
    if (!trimmed.startsWith('--')) return trimmed
    const nl = trimmed.indexOf('\n')
    if (nl === -1) return ''
    text = trimmed.slice(nl + 1)
  }
}

function collectFromFile(file, source, into) {
  for (const statement of splitStatements(readFileSync(file, 'utf8'))) {
    const match = stripLeadingComments(statement).match(PATTERN)
    if (!match) continue
    const key = `${match[1].toUpperCase()}:${match[2]}`
    const previous = into.get(key)
    // 同名再定义是合法的（CREATE OR REPLACE 的迁移式演进），但要留下痕迹：
    // 后定义覆盖先定义，provenance 记录全部来源，便于回答「这条现在生效的是哪份迁移写的」
    into.set(key, {
      source: previous ? `${previous.source} -> ${source}` : source,
      redefinedFrom: previous?.source,
      body: clean(statement),
    })
  }
  return into
}

export function collectGuards(dir) {
  const objects = new Map()
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
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
  for (const key of aggregateObjects.keys())
    if (!migrationObjects.has(key)) problems.push(`guards.sql 里有 ${key}，但没有任何 migration 定义它`)
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
  for (const [key, object] of objects) console.log(`   ${key}  ← ${object.source}`)
  process.exit(0)
}

// 反向自测：每条都必须报红，否则说明校验逻辑在退化。
// 写验证先于写实现 —— 这里的用例是先于 splitStatements 定下来的。
export function selfTest() {
  const temp = mkdtempSync(path.join(tmpdir(), 'guards-selftest-'))
  const results = []
  const check = (name, condition, detail) => results.push({ name, ok: Boolean(condition), detail })
  try {
    cpSync(migrationsDir, temp, { recursive: true })
    const pristine = () => collectGuards(temp)
    const baseline = aggregate()

    check('基线：未改动时无差异', compare(pristine(), baseline).length === 0, `${compare(pristine(), baseline).length} 条差异`)

    const triggerFile = path.join(temp, '20261119000100_pending_review_guards', 'migration.sql')
    const triggerOriginal = readFileSync(triggerFile, 'utf8')

    // 1. 删掉一个触发器对象
    writeFileSync(
      triggerFile,
      triggerOriginal.replace(/CREATE TRIGGER "problem_verified_needs_citation"[\s\S]*?;/, ''),
    )
    const removedTrigger = compare(pristine(), baseline)
    check(
      '删掉触发器 → 报红且点名该对象',
      removedTrigger.some((p) => p.includes('TRIGGER:problem_verified_needs_citation')),
      removedTrigger[0] ?? '无差异',
    )
    writeFileSync(triggerFile, triggerOriginal)

    // 2. 删掉一个 dollar-quoted 函数对象（旧切分器在这里会假装看不见）
    writeFileSync(
      triggerFile,
      triggerOriginal.replace(/CREATE OR REPLACE FUNCTION "studygraph_downgrade_when_last_citation_removed"[\s\S]*?\$\$;/, ''),
    )
    const removedFunction = compare(pristine(), baseline)
    check(
      '删掉 $$ 函数 → 报红且点名该函数',
      removedFunction.some((p) => p.includes('FUNCTION:studygraph_downgrade_when_last_citation_removed')),
      removedFunction[0] ?? '无差异（切分器把函数吞掉了）',
    )
    writeFileSync(triggerFile, triggerOriginal)

    // 3. 函数体改一个字符（旧切分器看不到函数体，这条会绿）
    writeFileSync(
      triggerFile,
      triggerOriginal.replace(
        /EXECUTE format\('SELECT count\(\*\) FROM %I WHERE %I = \$1', citation_table, fk_column\)/,
        "EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', citation_table, fk_column) /*x*/",
      ),
    )
    const mutatedFunction = compare(pristine(), baseline)
    check(
      '函数体改一个字符 → 报红且点名该函数',
      mutatedFunction.some((p) => p.includes('FUNCTION:studygraph_downgrade_when_last_citation_removed')),
      mutatedFunction[0] ?? '无差异（函数体没比）',
    )
    writeFileSync(triggerFile, triggerOriginal)

    // 4. 触发器参数改一个值（VERIFIED → PENDING）：名字没变、正文变了
    writeFileSync(
      triggerFile,
      triggerOriginal.replace("'ProblemCitation', 'problemId', 'VERIFIED'", "'ProblemCitation', 'problemId', 'PENDING'"),
    )
    const mutatedArgs = compare(pristine(), baseline)
    check(
      '触发器参数改值 → 报红且点名该触发器',
      mutatedArgs.some((p) => p.includes('TRIGGER:problem_verified_needs_citation')),
      mutatedArgs[0] ?? '无差异（只比了对象名）',
    )
    writeFileSync(triggerFile, triggerOriginal)

    // 5. guards.sql 缺对象 / 多对象
    const missing = new Map(baseline)
    missing.delete('FUNCTION:studygraph_assert_citation_before_verify')
    check('guards.sql 缺对象 → 报红', compare(pristine(), missing).length > 0, '缺少时未报')

    const extra = new Map(baseline)
    extra.set('VIEW:v_not_in_any_migration', { source: 'guards.sql', body: 'CREATE VIEW v_not_in_any_migration' })
    check('guards.sql 多对象 → 报红', compare(pristine(), extra).length > 0, '多余时未报')

    // 6. 同名对象在两个迁移里重新定义过 → provenance 必须留下两条来源
    const redefined = [...pristine()].filter(([, object]) => object.redefinedFrom)
    check(
      '同名重定义留下 provenance',
      redefined.length > 0,
      redefined.length > 0 ? redefined.map(([key, o]) => `${key}: ${o.source}`).join(' | ') : '没有任何对象记录 redefinedFrom',
    )

    return results
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (process.argv.includes('--self-test')) {
  const results = selfTest()
  const failed = results.filter((r) => !r.ok)
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name} — ${r.detail}`)
  if (failed.length > 0) {
    console.error(`\n❌ 自测失败 ${failed.length}/${results.length}`)
    process.exit(1)
  }
  console.log(`\n✅ 自测全部通过（${results.length} 条）`)
  process.exit(0)
}

const problems = compare(collectGuards(migrationsDir), aggregate())
if (problems.length > 0) {
  console.error(`❌ guards 不同步（${problems.length} 条）`)
  for (const problem of problems.slice(0, 10)) console.error(`   ${problem}`)
  process.exit(1)
}
console.log(`✅ guards 同步（${collectGuards(migrationsDir).size} 个守卫对象，覆盖全部 migration）`)
