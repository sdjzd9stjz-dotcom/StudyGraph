-- =============================================================================
-- StudyGraph · 数据库不变量（聚合源文件，供人阅读，不直接执行）
-- =============================================================================
-- 本文件由以下 migration 按顺序拼接而成，库里的东西只由 migration 产生：
--   20261118030100_guards            CHECK 7 / 触发器 6 / 视图 4 / 索引 2
--   20261119000000_edge_no_self_loop （CHECK 1：禁止自环边）
--
-- 校验：node scripts/check-guards-sync.mjs（按 SQL 语句流比对，忽略注释与空行）
-- 改动顺序：先改 migration → 重建本文件 → 跑校验脚本。禁止只改这里。
-- =============================================================================

-- =============================================================================
-- StudyGraph · 数据库不变量（migration 20261118030100_guards）
-- =============================================================================
-- 本文件是唯一被执行的那份。packages/db/sql/guards.sql 是逐字节副本，
-- scripts/check-guards-sync.mjs 会校验两者一致，防止"改了源文件忘了迁移"。
--
-- 为什么单独一个 migration：Prisma schema 表达不了 CHECK / 触发器 / 视图。
-- 放进 migration 链路后，`prisma migrate deploy` 与 shadow database 都自带这些约束，
-- 换机器不会得到一个"没有约束也不会报错"的裸库。
--
-- 验证状态：⚠ 2026-11-18 已在 PGlite(PostgreSQL 16 WASM) 上完整执行并跑过负向用例；
-- 尚未在 pgvector/pgvector:pg16 容器上执行（本机没有 Docker）。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. 扩展与检索索引
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "vector";      -- pgvector：概念语义邻接
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- 概念名模糊检索

-- 语义邻接近似最近邻（HNSW，cosine）。维度必须与 schema 中 vector(1536) 一致。
CREATE INDEX IF NOT EXISTS "Concept_embedding_hnsw"
  ON "Concept" USING hnsw ("embedding" vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "Concept_name_trgm"
  ON "Concept" USING gin ("name" gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- 1. 数值域：掌握度 / 熟练度 / 难度都是有界量
--    合并或越界都会让诊断失去意义，因此由数据库拒绝。
-- -----------------------------------------------------------------------------
ALTER TABLE "Concept"
  ADD CONSTRAINT "concept_mastery_range"
  CHECK ("mastery" >= 0 AND "mastery" <= 1);

ALTER TABLE "Method"
  ADD CONSTRAINT "method_proficiency_range"
  CHECK ("proficiency" >= 0 AND "proficiency" <= 1);

ALTER TABLE "Problem"
  ADD CONSTRAINT "problem_difficulty_range"
  CHECK ("difficulty" >= 0 AND "difficulty" <= 5);

-- 原文区间必须非空且有序，否则溯源高亮会指向不存在的位置。
ALTER TABLE "Span"
  ADD CONSTRAINT "span_char_range"
  CHECK ("charStart" >= 0 AND "charEnd" > "charStart");

-- 题目的状态与理由必须自洽：REJECTED 无理由 = 无法向学生解释为何没入库。
ALTER TABLE "Problem"
  ADD CONSTRAINT "problem_rejected_has_reason"
  CHECK ("status" <> 'REJECTED' OR ("rejectReason" IS NOT NULL AND length(btrim("rejectReason")) > 0));

ALTER TABLE "Problem"
  ADD CONSTRAINT "problem_verified_has_no_reject_reason"
  CHECK ("status" <> 'VERIFIED' OR "rejectReason" IS NULL);

-- 选择题必须给出选项；没选项的单选题在 UI 层就是坏数据。
-- 用 CASE 包住 jsonb_array_length：options 不是数组时不能让函数本身报错，
-- 否则约束失败的原因会变成"类型错误"而不是"缺选项"。
ALTER TABLE "Problem"
  ADD CONSTRAINT "problem_choice_has_options"
  CHECK (
    "type" NOT IN ('SINGLE_CHOICE', 'MULTI_CHOICE')
    OR coalesce(
         jsonb_array_length(
           CASE WHEN jsonb_typeof("options") = 'array' THEN "options" END
         ),
         0
       ) >= 2
  );

-- -----------------------------------------------------------------------------
-- 2. 溯源是物理约束：没有 span 引用的资产不得标记为 VERIFIED
--    正确流程：先建 UNVERIFIED 资产 → 写引用 → 再置 VERIFIED。
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "studygraph_assert_citation_before_verify"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ref_count integer;
BEGIN
  IF NEW."status" = 'VERIFIED' THEN
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE %I = $1',
      TG_ARGV[0], TG_ARGV[1]
    ) INTO ref_count USING NEW."id";

    IF ref_count = 0 THEN
      RAISE EXCEPTION
        '% % cannot be VERIFIED without at least one source span citation',
        TG_TABLE_NAME, NEW."id"
        USING ERRCODE = 'check_violation',
              HINT = 'Insert the citation row first, then set status = VERIFIED.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "concept_verified_needs_citation"
  BEFORE INSERT OR UPDATE OF "status" ON "Concept"
  FOR EACH ROW
  EXECUTE FUNCTION "studygraph_assert_citation_before_verify"('ConceptCitation', 'conceptId');

CREATE TRIGGER "method_verified_needs_citation"
  BEFORE INSERT OR UPDATE OF "status" ON "Method"
  FOR EACH ROW
  EXECUTE FUNCTION "studygraph_assert_citation_before_verify"('MethodCitation', 'methodId');

CREATE TRIGGER "problem_verified_needs_citation"
  BEFORE INSERT OR UPDATE OF "status" ON "Problem"
  FOR EACH ROW
  EXECUTE FUNCTION "studygraph_assert_citation_before_verify"('ProblemCitation', 'problemId');

-- -----------------------------------------------------------------------------
-- 3. 引用被删光时把父实体降级
--    只靠 BEFORE UPDATE 触发器只能拦住"写入时无引用"，
--    删掉最后一条引用后 VERIFIED 会失守。这条 AFTER DELETE 补上缺口。
--    降级方向（VERIFIED → UNVERIFIED）不会被第 2 节的触发器拦住。
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "studygraph_downgrade_when_last_citation_removed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  citation_table text    := TG_ARGV[0];
  fk_column      text    := TG_ARGV[1];
  parent_table   text    := TG_ARGV[2];
  parent_id      text    := to_jsonb(OLD) ->> fk_column;
  remaining      integer;
BEGIN
  IF parent_id IS NULL THEN
    RETURN OLD;
  END IF;

  EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', citation_table, fk_column)
    INTO remaining USING parent_id;

  IF remaining = 0 THEN
    EXECUTE format(
      'UPDATE %I SET "status" = ''UNVERIFIED'' WHERE "id" = $1 AND "status" = ''VERIFIED''',
      parent_table
    ) USING parent_id;
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER "concept_citation_delete_downgrade"
  AFTER DELETE ON "ConceptCitation"
  FOR EACH ROW
  EXECUTE FUNCTION "studygraph_downgrade_when_last_citation_removed"(
    'ConceptCitation', 'conceptId', 'Concept'
  );

CREATE TRIGGER "method_citation_delete_downgrade"
  AFTER DELETE ON "MethodCitation"
  FOR EACH ROW
  EXECUTE FUNCTION "studygraph_downgrade_when_last_citation_removed"(
    'MethodCitation', 'methodId', 'Method'
  );

CREATE TRIGGER "problem_citation_delete_downgrade"
  AFTER DELETE ON "ProblemCitation"
  FOR EACH ROW
  EXECUTE FUNCTION "studygraph_downgrade_when_last_citation_removed"(
    'ProblemCitation', 'problemId', 'Problem'
  );

-- -----------------------------------------------------------------------------
-- 4. 不变量审计视图
--    供 scripts/check-gates.ts 与 CI 定期扫描；写入路径不依赖它们。
-- -----------------------------------------------------------------------------

-- 4.1 每个干扰项必须绑定错因。正确答案不参与此判定。
CREATE OR REPLACE VIEW "v_problem_distractor_without_error_tag" AS
SELECT
  p."id"       AS "problemId",
  p."canvasId" AS "canvasId",
  p."status"   AS "status",
  opt."value"  AS "option"
FROM "Problem" p
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(p."options") = 'array' THEN p."options" ELSE '[]'::jsonb END
) AS opt("value")
WHERE p."type" IN ('SINGLE_CHOICE', 'MULTI_CHOICE')
  AND COALESCE(opt."value" ->> 'errorTag', '') = ''
  AND NOT (
    CASE
      WHEN jsonb_typeof(p."answer") = 'array' THEN (p."answer" ? (opt."value" ->> 'key'))
      ELSE (p."answer" ->> 'key') = (opt."value" ->> 'key')
    END
  );

-- 4.2 VERIFIED 却无引用的资产（触发器存在时该视图应为空；用于发现触发器被绕过）
CREATE OR REPLACE VIEW "v_verified_without_citation" AS
SELECT 'Concept'::text AS "kind", c."id" AS "entityId"
FROM "Concept" c
WHERE c."status" = 'VERIFIED'
  AND NOT EXISTS (SELECT 1 FROM "ConceptCitation" cc WHERE cc."conceptId" = c."id")
UNION ALL
SELECT 'Method'::text, m."id"
FROM "Method" m
WHERE m."status" = 'VERIFIED'
  AND NOT EXISTS (SELECT 1 FROM "MethodCitation" mc WHERE mc."methodId" = m."id")
UNION ALL
SELECT 'Problem'::text, pr."id"
FROM "Problem" pr
WHERE pr."status" = 'VERIFIED'
  AND NOT EXISTS (SELECT 1 FROM "ProblemCitation" pc WHERE pc."problemId" = pr."id");

-- 4.3 组卷报告缺口：report 里写了 gap 的试卷必须能被查到。
CREATE OR REPLACE VIEW "v_paper_with_coverage_gap" AS
SELECT
  pp."id"     AS "paperId",
  pp."title"  AS "title",
  pp."report" AS "report"
FROM "Paper" pp
WHERE pp."status" = 'READY'
  AND jsonb_array_length(
        CASE
          WHEN jsonb_typeof(pp."report" -> 'gaps') = 'array' THEN pp."report" -> 'gaps'
          ELSE '[]'::jsonb
        END
      ) > 0;

-- 4.4 Method.steps[].conceptIds 与 MethodConcept 是两份数据，迟早漂移。
--     三种不一致：
--       STEP_WITHOUT_METHODCONCEPT   步骤里引用了，关系表没有
--       METHODCONCEPT_NOT_IN_STEPS   关系表有，步骤里没引用
--       STEP_CONCEPT_MISSING         步骤里引用的 conceptId 在库里不存在
CREATE OR REPLACE VIEW "v_method_concept_mismatch" AS
WITH step_concepts AS (
  SELECT
    m."id" AS "methodId",
    CASE
      WHEN (s."value" ->> 'order') ~ '^[0-9]+$' THEN (s."value" ->> 'order')::int
      ELSE s."ord"::int
    END AS "stepOrder",
    c."value" AS "conceptId"
  FROM "Method" m
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(m."steps") = 'array' THEN m."steps" ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS s("value", ord)
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(s."value" -> 'conceptIds') = 'array' THEN s."value" -> 'conceptIds'
      ELSE '[]'::jsonb
    END
  ) AS c("value")
)
SELECT
  'STEP_WITHOUT_METHODCONCEPT'::text AS "mismatch",
  st."methodId"   AS "methodId",
  st."conceptId"  AS "conceptId",
  st."stepOrder"  AS "stepOrder"
FROM step_concepts st
LEFT JOIN "MethodConcept" mc
  ON mc."methodId" = st."methodId" AND mc."conceptId" = st."conceptId"
WHERE mc."methodId" IS NULL
UNION ALL
SELECT
  'METHODCONCEPT_NOT_IN_STEPS'::text,
  mc."methodId",
  mc."conceptId",
  NULL::int
FROM "MethodConcept" mc
WHERE NOT EXISTS (
  SELECT 1 FROM step_concepts st
  WHERE st."methodId" = mc."methodId" AND st."conceptId" = mc."conceptId"
)
UNION ALL
SELECT
  'STEP_CONCEPT_MISSING'::text,
  st."methodId",
  st."conceptId",
  st."stepOrder"
FROM step_concepts st
WHERE NOT EXISTS (
  SELECT 1 FROM "Concept" c WHERE c."id" = st."conceptId"
);

-- =============================================================================
-- 禁止自环边（SG-SUP-002 §2.2 / P2-1）
-- =============================================================================
-- 为什么单独一个 migration 而不是改 20261118030100_guards：
-- 那份已经应用并记账了校验和，改一个字节 `migrate deploy` 就会因 checksum 失配报错。
--
-- 为什么必须在数据库层拦：服务层第 3 条检查（fromNodeId !== toNodeId）漏写时，
-- 自环会让 topoSort 永远无解、stale 传播在自身节点上收敛不了。
-- CHECK 是最后一道，不依赖任何调用方记得校验。
--
-- 注意：本约束加入后，CHECK 总数由 7 变 8（SG-SUP-002 §1.2 的预期是加约束前的值）。
-- =============================================================================

ALTER TABLE "Edge"
  ADD CONSTRAINT "edge_no_self_loop"
  CHECK ("fromNodeId" <> "toNodeId");
