-- =============================================================================
-- 下游收集（递归 CTE 版）
-- =============================================================================
-- 与 apps/api/src/domain/graph/dag.ts 的纯函数版本互为验证：
--   单节点判断用纯函数（快、可单测）；批量/深链用这条 SQL（一次往返）。
--
-- 用法：psql -v start='<nodeId>' -f packages/db/sql/downstream.sql
-- 或由 packages/db/src/graph-sql.ts 以 $1 参数调用。
--
-- 关键点：
--   * 只沿 Edge 的三种语义展开，默认只 DERIVED_FROM
--   * path 数组做环路保护（节点图必须是无环 DAG，但脏数据不设防就会死循环）
--   * depth 上限 64，防止异常数据把库拖死
-- =============================================================================

WITH RECURSIVE downstream AS (
  SELECT
    e."toNodeId"        AS "nodeId",
    1                   AS depth,
    ARRAY[e."fromNodeId", e."toNodeId"] AS path
  FROM "Edge" e
  WHERE e."fromNodeId" = $1
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
SELECT DISTINCT "nodeId"
FROM downstream
ORDER BY 1;
