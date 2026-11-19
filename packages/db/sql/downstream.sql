-- =============================================================================
-- 下游收集（递归 CTE 版）
-- =============================================================================
-- 与 apps/api/src/domain/graph/dag.ts 的 collectDownstream **语义必须一致**：
--   只沿 DERIVED_FROM 展开（理由见 dag.ts 文件头与 docs/architecture.md §4.0）。
--   一致性由 apps/api/test/integration/downstream-equivalence.test.ts 在真实 PG 上比对。
--
-- 用法（psql）：
--   psql "$DATABASE_URL" -v start="'<nodeId>'" -tA -f packages/db/sql/downstream.sql
--   -v 的值要带引号，因为 SQL 里用 :'start' 做文本插值。
--   Node / Prisma $queryRaw 版本把 :'start' 换成 $1 即可。
--
-- 输出列：
--   nodeId     下游节点
--   depth      最短展开层数（1 = 直接下游）
--   truncated  该节点处于被深度上限截断的位置（true = 还有更深的下游没展开）
--
-- 环路保护：path 数组防止 A→B→A 死循环。
-- 深度上限：depth < 64。**到 64 不报错，而是把 truncated 置 true**——
--           调用方必须检查，否则会把"没算完"当成"算完了"（SG-SUP-002 §4 / P2-5）。
-- =============================================================================

WITH RECURSIVE downstream AS (
  SELECT
    e."toNodeId"                        AS "nodeId",
    1                                   AS depth,
    ARRAY[e."fromNodeId", e."toNodeId"] AS path
  FROM "Edge" e
  WHERE e."fromNodeId" = :'start'
    AND e.kind = 'DERIVED_FROM'

  UNION ALL

  SELECT
    e."toNodeId",
    d.depth + 1,
    d.path || e."toNodeId"
  FROM downstream d
  JOIN "Edge" e
    ON e."fromNodeId" = d."nodeId"
   AND e.kind = 'DERIVED_FROM'
  WHERE d.depth < 64
    AND NOT e."toNodeId" = ANY(d.path)
)
SELECT
  "nodeId",
  min(depth)           AS "depth",
  bool_or(depth >= 64) AS "truncated"
FROM downstream
GROUP BY "nodeId"
ORDER BY 1;
