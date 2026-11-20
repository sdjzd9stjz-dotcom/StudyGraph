-- =============================================================================
-- 迁移 2/2（修正版）· PENDING_REVIEW 只作用于 Concept / Method（SG-SUP-011 §1）
-- =============================================================================
-- 上一版把 'PENDING_REVIEW' 硬编码进共享触发函数，而 Problem 用的是
-- ProblemStatus(PENDING/VERIFIED/REJECTED) —— 一执行就 22P02。
--
-- 修正原则：**共享函数不认枚举值，只认调用方传进来的状态集**。
--   Concept / Method：需要引用的状态 = VERIFIED, PENDING_REVIEW；降级目标 = UNVERIFIED
--   Problem        ：需要引用的状态 = VERIFIED；               降级目标 = PENDING
-- 并且一律用 ::text 比较，避免枚举类型打架。
-- =============================================================================

-- 1. 复核痕迹
ALTER TABLE "Concept" ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE "Concept" ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT;
ALTER TABLE "Method"  ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE "Method"  ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT;

-- 2. 写状态前必须已有引用：需要引用的状态集由调用方通过 TG_ARGV[2:] 传入
CREATE OR REPLACE FUNCTION "studygraph_assert_citation_before_verify"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ref_count integer;
BEGIN
  -- TG_ARGV[0]=引用表  TG_ARGV[1]=外键列  TG_ARGV[2:]=需要引用的状态
  IF NEW."status"::text = ANY (TG_ARGV[2:]) THEN
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE %I = $1',
      TG_ARGV[0], TG_ARGV[1]
    ) INTO ref_count USING NEW."id";

    IF ref_count = 0 THEN
      RAISE EXCEPTION
        '% % cannot be % without at least one source span citation',
        TG_TABLE_NAME, NEW."id", NEW."status"
        USING ERRCODE = 'check_violation',
              HINT = 'Insert the citation row first, then set status.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 触发器参数变了，必须重建
DROP TRIGGER IF EXISTS "concept_verified_needs_citation" ON "Concept";
DROP TRIGGER IF EXISTS "method_verified_needs_citation" ON "Method";
DROP TRIGGER IF EXISTS "problem_verified_needs_citation" ON "Problem";

CREATE TRIGGER "concept_verified_needs_citation"
  BEFORE INSERT OR UPDATE OF "status" ON "Concept"
  FOR EACH ROW
  EXECUTE FUNCTION "studygraph_assert_citation_before_verify"(
    'ConceptCitation', 'conceptId', 'VERIFIED', 'PENDING_REVIEW');

CREATE TRIGGER "method_verified_needs_citation"
  BEFORE INSERT OR UPDATE OF "status" ON "Method"
  FOR EACH ROW
  EXECUTE FUNCTION "studygraph_assert_citation_before_verify"(
    'MethodCitation', 'methodId', 'VERIFIED', 'PENDING_REVIEW');

-- Problem 只有 VERIFIED 需要引用：PENDING 是"待三检"，REJECTED 不该有引用
CREATE TRIGGER "problem_verified_needs_citation"
  BEFORE INSERT OR UPDATE OF "status" ON "Problem"
  FOR EACH ROW
  EXECUTE FUNCTION "studygraph_assert_citation_before_verify"(
    'ProblemCitation', 'problemId', 'VERIFIED');

-- 3. 删光引用时降级：降级目标也必须按实体传参
--    Concept/Method → UNVERIFIED；Problem → PENDING（ProblemStatus 没有 UNVERIFIED）
CREATE OR REPLACE FUNCTION "studygraph_downgrade_when_last_citation_removed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  citation_table text := TG_ARGV[0];
  fk_column      text := TG_ARGV[1];
  parent_table   text := TG_ARGV[2];
  target_status  text := TG_ARGV[3];
  parent_id      text := to_jsonb(OLD) ->> fk_column;
  remaining      integer;
BEGIN
  IF parent_id IS NULL THEN
    RETURN OLD;
  END IF;

  EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', citation_table, fk_column)
    INTO remaining USING parent_id;

  IF remaining = 0 THEN
    -- TG_ARGV[4:]=需要降级的来源状态
    EXECUTE format(
      'UPDATE %I SET "status" = %L WHERE "id" = $1 AND "status"::text = ANY ($2)',
      parent_table, target_status
    ) USING parent_id, TG_ARGV[4:];
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS "concept_citation_delete_downgrade" ON "ConceptCitation";
DROP TRIGGER IF EXISTS "method_citation_delete_downgrade" ON "MethodCitation";
DROP TRIGGER IF EXISTS "problem_citation_delete_downgrade" ON "ProblemCitation";

CREATE TRIGGER "concept_citation_delete_downgrade"
  AFTER DELETE ON "ConceptCitation"
  FOR EACH ROW
  EXECUTE FUNCTION "studygraph_downgrade_when_last_citation_removed"(
    'ConceptCitation', 'conceptId', 'Concept', 'UNVERIFIED', 'VERIFIED', 'PENDING_REVIEW');

CREATE TRIGGER "method_citation_delete_downgrade"
  AFTER DELETE ON "MethodCitation"
  FOR EACH ROW
  EXECUTE FUNCTION "studygraph_downgrade_when_last_citation_removed"(
    'MethodCitation', 'methodId', 'Method', 'UNVERIFIED', 'VERIFIED', 'PENDING_REVIEW');

CREATE TRIGGER "problem_citation_delete_downgrade"
  AFTER DELETE ON "ProblemCitation"
  FOR EACH ROW
  EXECUTE FUNCTION "studygraph_downgrade_when_last_citation_removed"(
    'ProblemCitation', 'problemId', 'Problem', 'PENDING', 'VERIFIED');

-- 4. 视图：Problem 段只认 VERIFIED（它没有 PENDING_REVIEW）
CREATE OR REPLACE VIEW "v_verified_without_citation" AS
SELECT 'Concept'::text AS "kind", c."id" AS "entityId"
FROM "Concept" c
WHERE c."status" IN ('VERIFIED', 'PENDING_REVIEW')
  AND NOT EXISTS (SELECT 1 FROM "ConceptCitation" cc WHERE cc."conceptId" = c."id")
UNION ALL
SELECT 'Method'::text, m."id"
FROM "Method" m
WHERE m."status" IN ('VERIFIED', 'PENDING_REVIEW')
  AND NOT EXISTS (SELECT 1 FROM "MethodCitation" mc WHERE mc."methodId" = m."id")
UNION ALL
SELECT 'Problem'::text, pr."id"
FROM "Problem" pr
WHERE pr."status" = 'VERIFIED'
  AND NOT EXISTS (SELECT 1 FROM "ProblemCitation" pc WHERE pc."problemId" = pr."id");
