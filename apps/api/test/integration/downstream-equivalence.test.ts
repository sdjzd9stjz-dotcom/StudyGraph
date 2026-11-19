/**
 * 跨实现等价性：纯函数 collectDownstream 与 SQL 递归 CTE 必须给出同一个答案。
 *
 * 这是集成测试，不是单测——它连真实 PG16 容器（`studygraph-postgres`），
 * 因为要证明的正是"两边在真库上一致"，用纯函数自己跟自己比没有意义。
 *
 * 前置：docker compose up -d postgres，容器名 studygraph-postgres。
 * 运行：node apps/api/test/integration/downstream-equivalence.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { collectDownstream } from '../../src/domain/graph/dag.ts'
import type { EdgeLike } from '../../src/domain/graph/dag.ts'

const REPO = path.resolve(import.meta.dirname, '../../../..')
const CONTAINER = process.env.STUDYGRAPH_CONTAINER ?? 'studygraph-postgres'
const DOWNSTREAM_SQL = readFileSync(path.join(REPO, 'packages/db/sql/downstream.sql'), 'utf8')

function psql(sql: string, vars: Array<[string, string]> = []): string {
  const args = ['exec', '-i', CONTAINER, 'psql', '-U', 'studygraph', '-d', 'studygraph', '-tA', '-v', 'ON_ERROR_STOP=1']
  for (const [key, value] of vars) args.push('-v', `${key}=${value}`)
  return execFileSync('docker', args, { input: sql, encoding: 'utf8' }).trim()
}

/** 同一张图，两边各写一份：fixture 写进库，edges 喂给纯函数。 */
const EDGES: EdgeLike[] = [
  { fromNodeId: 'n_a', toNodeId: 'n_b', kind: 'DERIVED_FROM' },
  { fromNodeId: 'n_b', toNodeId: 'n_c', kind: 'DERIVED_FROM' },
  { fromNodeId: 'n_a', toNodeId: 'n_d', kind: 'CITES' },
  { fromNodeId: 'n_a', toNodeId: 'n_e', kind: 'PREREQUISITE' },
  { fromNodeId: 'n_e', toNodeId: 'n_c', kind: 'PREREQUISITE' },
]

const FIXTURE = `
DELETE FROM "Canvas" WHERE id = 'cv_eq';
DELETE FROM "User" WHERE id = 'u_eq';
INSERT INTO "User"(id, email, "displayName", locale, "createdAt", "updatedAt")
VALUES ('u_eq', 'eq@t.t', 'eq', 'zh-CN', now(), now());
INSERT INTO "Canvas"(id, "ownerId", title, visibility, "isTemplate", "forkCount", "createdAt", "updatedAt")
VALUES ('cv_eq', 'u_eq', 'equivalence', 'PRIVATE', false, 0, now(), now());
INSERT INTO "Node"(id, "canvasId", type, params, status, "posX", "posY", "createdAt", "updatedAt")
VALUES ${['n_a', 'n_b', 'n_c', 'n_d', 'n_e']
  .map((id, i) => `('${id}', 'cv_eq', 'CHUNK', '{}'::jsonb, 'DRAFT', ${i}, 0, now(), now())`)
  .join(',\n       ')};
INSERT INTO "Edge"(id, "canvasId", "fromNodeId", "toNodeId", kind, "fromPort", "toPort", "createdAt")
VALUES ${EDGES.map(
  (edge, i) =>
    `('e_eq_${i}', 'cv_eq', '${edge.fromNodeId}', '${edge.toNodeId}', '${edge.kind}', 'out', 'in', now())`,
).join(',\n       ')};
`

test('同一张图：纯函数与 SQL 的下游结果 deepEqual（P1-1）', () => {
  try {
    psql(FIXTURE)

    for (const [start, label] of [
      ['n_a', '起点 A：经 DERIVED_FROM 到 B、C；CITES/PREREQUISITE 分支不得进入'],
      ['n_b', '起点 B：只有 C'],
      ['n_d', '起点 D：只有 CITES 出边，下游必须为空'],
      ['n_c', '起点 C：叶子节点，下游必须为空'],
    ] as const) {
      const rows = psql(DOWNSTREAM_SQL, [['start', start]])
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => line.split('|')[0]?.trim() ?? '')

      const fromSql = rows.slice().sort()
      const fromPure = collectDownstream(EDGES, start).slice().sort()

      assert.deepEqual(fromSql, fromPure, `${label}：SQL=[${fromSql}] 纯函数=[${fromPure}]`)
      assert.equal(
        psql(DOWNSTREAM_SQL, [['start', start]]).includes('t'),
        false,
        '本图深度远小于 64，不应出现 truncated=true',
      )
    }
  } finally {
    psql(`DELETE FROM "Canvas" WHERE id = 'cv_eq'; DELETE FROM "User" WHERE id = 'u_eq';`)
  }
})

test('SQL 只走 DERIVED_FROM：把 CITES 起点单独跑一遍必须是空集', () => {
  try {
    psql(FIXTURE)
    const out = psql(DOWNSTREAM_SQL, [['start', 'n_d']]).trim()
    assert.equal(out, '', `期望空集，实际=${out}`)
  } finally {
    psql(`DELETE FROM "Canvas" WHERE id = 'cv_eq'; DELETE FROM "User" WHERE id = 'u_eq';`)
  }
})
