-- =============================================================================
-- migration 2/2 · 使用 PENDING_REVIEW：列 + 触发器 + 视图（SG-SUP-010 §2.2）
-- =============================================================================
-- PENDING_REVIEW 的唯一合法性来源是"引文能在原文里查到"。
-- 如果允许无引用的 PENDING_REVIEW 存在，它比 VERIFIED 更危险——
-- 因为它看起来像被审核过。所以触发器必须把 PENDING_REVIEW 也算进来。
-- =============================================================================

-- 1. 复核痕迹（SG-SUP-010 §2.5）
ALTER TABLE "Concept" ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE "Concept" ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT;
ALTER TABLE "Method"  ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE "Method"  ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT;

-- 2. 触发函数：VERIFIED 或 PENDING_REVIEW 都必须有引用
CREATE OR REPLACE FUNCTION "studygraph_assert_citation_before_verify"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ref_count integer;
BEGIN
  IF NEW."status" IN ('VERIFIED', 'PENDING_REVIEW') THEN
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE %I = $1',
      TG_ARGV[0], TG_ARGV[1]
    ) INTO ref_count USING NEW."id";

    IF ref_count = 0 THEN
      RAISE EXCEPTION
        '% % cannot be VERIFIED or PENDING_REVIEW without at least one source span citation',
        TG_TABLE_NAME, NEW."id"
        USING ERRCODE = 'check_violation',
              HINT = 'Insert the citation row first, then set status.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 3. 删光引用时的降级：待审的也要降级，否则它会一直挂着"待审"却没人再看
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
      'UPDATE %I SET "status" = ''UNVERIFIED'' WHERE "id" = $1 AND "status" IN (''VERIFIED'', ''PENDING_REVIEW'')',
      parent_table
    ) USING parent_id;
  END IF;

  RETURN OLD;
END;
$$;

-- 4. 视图：把 PENDING_REVIEW 也算进"必须有引用"的口径
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
WHERE pr."status" IN ('VERIFIED', 'PENDING_REVIEW')
  AND NOT EXISTS (SELECT 1 FROM "ProblemCitation" pc WHERE pc."problemId" = pr."id");
