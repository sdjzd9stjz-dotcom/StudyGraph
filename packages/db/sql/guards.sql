-- =============================================================================
-- guards.sql —— 由 scripts/check-guards-sync.mjs --rebuild 生成，勿手改
-- 内容 = migrations/ 下全部 migration.sql 里守卫对象的最后定义
-- =============================================================================
CREATE TRIGGER "concept_verified_needs_citation" BEFORE INSERT OR UPDATE OF "status" ON "Concept" FOR EACH ROW EXECUTE FUNCTION "studygraph_assert_citation_before_verify"( 'ConceptCitation', 'conceptId', 'VERIFIED', 'PENDING_REVIEW');

CREATE TRIGGER "method_verified_needs_citation" BEFORE INSERT OR UPDATE OF "status" ON "Method" FOR EACH ROW EXECUTE FUNCTION "studygraph_assert_citation_before_verify"( 'MethodCitation', 'methodId', 'VERIFIED', 'PENDING_REVIEW');

CREATE TRIGGER "problem_verified_needs_citation" BEFORE INSERT OR UPDATE OF "status" ON "Problem" FOR EACH ROW EXECUTE FUNCTION "studygraph_assert_citation_before_verify"('ProblemCitation', 'problemId');

CREATE TRIGGER "concept_citation_delete_downgrade" AFTER DELETE ON "ConceptCitation" FOR EACH ROW EXECUTE FUNCTION "studygraph_downgrade_when_last_citation_removed"( 'ConceptCitation', 'conceptId', 'Concept', 'UNVERIFIED', 'VERIFIED', 'PENDING_REVIEW');

CREATE TRIGGER "method_citation_delete_downgrade" AFTER DELETE ON "MethodCitation" FOR EACH ROW EXECUTE FUNCTION "studygraph_downgrade_when_last_citation_removed"( 'MethodCitation', 'methodId', 'Method', 'UNVERIFIED', 'VERIFIED', 'PENDING_REVIEW');

CREATE TRIGGER "problem_citation_delete_downgrade" AFTER DELETE ON "ProblemCitation" FOR EACH ROW EXECUTE FUNCTION "studygraph_downgrade_when_last_citation_removed"( 'ProblemCitation', 'problemId', 'Problem', 'PENDING', 'VERIFIED');
