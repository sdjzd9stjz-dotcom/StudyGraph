// SQL 不变量验证器（可选工具，不是项目依赖）
//
// 用途：在没有 Docker 的机器上，用 PGlite（PostgreSQL 编译到 WASM）把
// packages/db/prisma/migrations 下的两个迁移原样跑一遍，验证 CHECK / 触发器 / 视图
// 的行为是否符合 docs/architecture.md §8 的约定。
//
// 为什么不在 package.json 里：这是验证工具，不进运行时依赖。
// 复现方式（仓库外）：
//   mkdir %TEMP%\pgverify && cd %TEMP%\pgverify
//   npm i @electric-sql/pglite@0.3.14 --cache %TEMP%\npmcache
//   然后：PGLITE_DIR=%TEMP%\pgverify node scripts/verify-sql.mjs
//
// 注意：PGlite 是 PostgreSQL 16 的 WASM 构建，能证明 SQL 语义正确；但它不替代
// 在 pgvector/pgvector:pg16 容器上的最终验收。

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const pgliteDir =
  process.env.PGLITE_DIR ?? path.join(process.env.TEMP ?? '', 'pgverify')

const pgModulePath = path.join(pgliteDir, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')
const trgmModulePath = path.join(pgliteDir, 'node_modules', '@electric-sql', 'pglite', 'dist', 'contrib', 'pg_trgm.js')
const vectorModulePath = path.join(pgliteDir, 'node_modules', '@electric-sql', 'pglite', 'dist', 'vector', 'index.js')

for (const p of [pgModulePath, trgmModulePath, vectorModulePath]) {
  if (!existsSync(p)) {
    console.error(`找不到 ${p}\n先按文件头注释把 @electric-sql/pglite 装到 PGLITE_DIR`)
    process.exit(1)
  }
}

const { PGlite } = await import(pathToFileURL(pgModulePath).href)
const { pg_trgm } = await import(pathToFileURL(trgmModulePath).href)
const { vector } = await import(pathToFileURL(vectorModulePath).href)

const initSqlPath = path.join(root, 'packages/db/prisma/migrations/20261118030000_init/migration.sql')
const guardsSqlPath = path.join(root, 'packages/db/prisma/migrations/20261118030100_guards/migration.sql')

/** 按 `;` 切语句，跳过单引号字符串、双引号标识符、行注释与 $$ 块。 */
function splitStatements(sql) {
  const statements = []
  let current = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      current += sql.slice(i, stop)
      i = stop
      continue
    }

    if (ch === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
        if (sql[j] === "'") break
        j++
      }
      current += sql.slice(i, j + 1)
      i = j + 1
      continue
    }

    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const end = sql.indexOf(tag, i + tag.length)
        const stop = end === -1 ? sql.length : end + tag.length
        current += sql.slice(i, stop)
        i = stop
        continue
      }
    }

    if (ch === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
      i++
      continue
    }

    current += ch
    i++
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}

const log = (msg) => console.log(msg)

const db = new PGlite({ extensions: { vector, pg_trgm } })
await db.waitReady

log('== engine ==')
log((await db.query('select version()')).rows[0].version)

log('\n== apply 20261118030000_init ==')
const initStatements = splitStatements(readFileSync(initSqlPath, 'utf8'))
for (const [index, statement] of initStatements.entries()) {
  try {
    await db.exec(statement)
  } catch (error) {
    console.error(`init statement #${index} 失败：\n${statement.slice(0, 200)}\n${error.message}`)
    process.exit(1)
  }
}
log(`init applied: ${initStatements.length} statements`)

log('\n== apply 20261118030100_guards ==')
const guardStatements = splitStatements(readFileSync(guardsSqlPath, 'utf8'))
for (const [index, statement] of guardStatements.entries()) {
  try {
    await db.exec(statement)
  } catch (error) {
    console.error(`guards statement #${index} 失败：\n${statement.slice(0, 300)}\n${error.message}`)
    process.exit(1)
  }
}
log(`guards applied: ${guardStatements.length} statements`)

log('\n== ① CHECK 约束数（预期 7）==')
log((await db.query(
  "select count(*)::int as n from pg_constraint where contype='c' and connamespace='public'::regnamespace",
)).rows[0].n)

log('\n== ② 非内部触发器数（预期 6：3 个写入守卫 + 3 个删除降级）==')
log((await db.query('select count(*)::int as n from pg_trigger where not tgisinternal')).rows[0].n)
log((await db.query(
  "select tgname from pg_trigger where not tgisinternal order by tgname",
)).rows.map((r) => r.tgname).join(', '))

log('\n== ③ 视图数（预期 4）==')
log((await db.query("select count(*)::int as n from pg_views where schemaname='public'")).rows[0].n)
log((await db.query(
  "select viewname from pg_views where schemaname='public' order by viewname",
)).rows.map((r) => r.viewname).join(', '))
// ── 造最小可用数据：User → Canvas → Node → Source → Span ──────────────────────
const now = 'now()'
const fixtures = `
INSERT INTO "User" ("id", "email", "displayName", "locale", "createdAt", "updatedAt")
VALUES ('u1', 'u1@example.com', 'u1', 'zh-CN', ${now}, ${now});
INSERT INTO "Canvas" ("id", "ownerId", "title", "visibility", "isTemplate", "forkCount", "createdAt", "updatedAt")
VALUES ('cv1', 'u1', '测试画布', 'PRIVATE', false, 0, ${now}, ${now});
INSERT INTO "Node" ("id", "canvasId", "type", "params", "status", "posX", "posY", "createdAt", "updatedAt")
VALUES ('n1', 'cv1', 'EXTRACT', '{}'::jsonb, 'READY', 0, 0, ${now}, ${now});
INSERT INTO "Source" ("id", "nodeId", "kind", "filename", "mimeType", "pageCount", "createdAt")
VALUES ('s1', 'n1', 'PDF', 'lecture.pdf', 'application/pdf', 10, ${now});
INSERT INTO "Span" ("id", "sourceId", "page", "charStart", "charEnd", "text", "createdAt")
VALUES ('sp1', 's1', 3, 0, 120, '曲线下面积与定积分的关系……', ${now});
`
await db.exec(fixtures)

log('\n== 3.3 跨画布连边必须被复合外键拒绝 ==')
await db.exec(`
  INSERT INTO "Canvas" ("id", "ownerId", "title", "visibility", "isTemplate", "forkCount", "createdAt", "updatedAt")
  VALUES ('cv2', 'u1', '另一个画布', 'PRIVATE', false, 0, ${now}, ${now});
  INSERT INTO "Node" ("id", "canvasId", "type", "params", "status", "posX", "posY", "createdAt", "updatedAt")
  VALUES ('n1b', 'cv1', 'CARD', '{}'::jsonb, 'READY', 0, 0, ${now}, ${now}),
         ('n2', 'cv2', 'CARD', '{}'::jsonb, 'READY', 0, 0, ${now}, ${now});
`)
try {
  await db.exec(`
    INSERT INTO "Edge" ("id", "canvasId", "fromNodeId", "toNodeId", "kind", "fromPort", "toPort", "createdAt")
    VALUES ('e_cross', 'cv1', 'n1', 'n2', 'DERIVED_FROM', 'out', 'in', ${now});
  `)
  console.log('❌ 跨画布边插入成功了 —— 复合外键没生效')
} catch (error) {
  console.log(`✅ 被拒绝：${error.message.split('\n')[0]}`)
}
await db.exec(`
  INSERT INTO "Edge" ("id", "canvasId", "fromNodeId", "toNodeId", "kind", "fromPort", "toPort", "createdAt")
  VALUES ('e_ok', 'cv1', 'n1', 'n1b', 'DERIVED_FROM', 'out', 'in', ${now});
`)
console.log(`同画布边：插入成功（${(await db.query('select count(*)::int as n from "Edge"')).rows[0].n} 条）`)

log('\n== ④ 负向用例：直接插入 VERIFIED 且无引用的 Concept ==')
try {
  await db.exec(`
    INSERT INTO "Concept" ("id", "canvasId", "name", "definition", "status",
                           "mastery", "dueAt", "reps", "lapses", "fsrsState", "createdAt", "updatedAt")
    VALUES ('c_bad', 'cv1', '坏概念', '无引用', 'VERIFIED',
            0, ${now}, 0, 0, '{}'::jsonb, ${now}, ${now});
  `)
  console.log('❌ 插入成功了 —— 触发器没生效')
} catch (error) {
  console.log(`✅ 被数据库拒绝：${error.message}`)
}

log('\n== 4.1 引用删除后降级 ==')
await db.exec(`
  INSERT INTO "Concept" ("id", "canvasId", "name", "definition", "status",
                         "mastery", "dueAt", "reps", "lapses", "fsrsState", "createdAt", "updatedAt")
  VALUES ('c1', 'cv1', '定积分', '曲线下面积', 'UNVERIFIED',
          0.3, ${now}, 0, 0, '{}'::jsonb, ${now}, ${now});
  INSERT INTO "ConceptCitation" ("id", "conceptId", "spanId", "isPrimary", "quote")
  VALUES ('cc1', 'c1', 'sp1', true, '曲线下面积');
  UPDATE "Concept" SET "status" = 'VERIFIED' WHERE "id" = 'c1';
`)
log(`置 VERIFIED 后：${(await db.query(`select "status" from "Concept" where "id"='c1'`)).rows[0].status}`)

await db.exec(`DELETE FROM "ConceptCitation" WHERE "id" = 'cc1';`)
log(`删掉唯一引用后：${(await db.query(`select "status" from "Concept" where "id"='c1'`)).rows[0].status}（预期 UNVERIFIED）`)

log('\n== 4.4 步骤与关系表不一致 ==')
await db.exec(`
  INSERT INTO "Concept" ("id", "canvasId", "name", "definition", "status",
                         "mastery", "dueAt", "reps", "lapses", "fsrsState", "createdAt", "updatedAt")
  VALUES ('c2', 'cv1', '换元法', '变量代换', 'UNVERIFIED',
          0, ${now}, 0, 0, '{}'::jsonb, ${now}, ${now}),
         ('c3', 'cv1', '分部积分', '乘积求导逆用', 'UNVERIFIED',
          0, ${now}, 0, 0, '{}'::jsonb, ${now}, ${now});

  INSERT INTO "Method" ("id", "canvasId", "name", "status", "trigger", "conditions", "steps", "checks",
                        "proficiency", "createdAt", "updatedAt")
  VALUES ('m1', 'cv1', '换元积分', 'UNVERIFIED',
          '[]'::jsonb, '[]'::jsonb,
          '[{"order":1,"goal":"换元","cue":"被积函数含复合项","action":"令 u=g(x)","why":"链式法则逆用","conceptIds":["c1","c2"]}]'::jsonb,
          '[]'::jsonb, 0, ${now}, ${now});

  -- 步骤引用了 c1、c2，关系表只登记 c1 → c2 应被抓到
  INSERT INTO "MethodConcept" ("methodId", "conceptId", "isCore") VALUES ('m1', 'c1', true);
  -- 关系表登记了 c3，但步骤里没引用 → 应被抓到
  INSERT INTO "MethodConcept" ("methodId", "conceptId", "isCore") VALUES ('m1', 'c3', false);
`)
log('场景 A（步骤缺登记 + 登记缺步骤）：')
log(JSON.stringify((await db.query(`
  select "mismatch", "methodId", "conceptId", "stepOrder"
  from "v_method_concept_mismatch" order by 1, 3
`)).rows, null, 2))

// 场景 B：步骤里引用一个库里不存在的 concept
await db.exec(`
  UPDATE "Method" SET "steps" = '[{"order":1,"goal":"换元","cue":"复合项","action":"令 u=g(x)","why":"链式法则","conceptIds":["c1","c_missing"]}]'::jsonb
  WHERE "id" = 'm1';
`)
log('场景 B（步骤引用不存在的 concept）：')
log(JSON.stringify((await db.query(`
  select "mismatch", "conceptId", "stepOrder"
  from "v_method_concept_mismatch" where "mismatch" = 'STEP_CONCEPT_MISSING'
`)).rows, null, 2))

log('\n== 审计视图应为空 ==')
log(JSON.stringify((await db.query('select * from "v_verified_without_citation"')).rows))
log(JSON.stringify((await db.query('select * from "v_problem_distractor_without_error_tag"')).rows))

await db.close()
