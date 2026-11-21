-- =============================================================================
-- M5 · 错因词典种子
-- =============================================================================
-- `ErrorTag` 在 M1 就建了表，但一直是空的。错因看板的下拉框与
-- diagnose 执行器的 code 归属都依赖它，空表会让界面出现"无法解释的项"。
--
-- 六个类别与 enum ErrorCategory 一一对应，每个类别给一个通用 code；
-- 具体到"哪一步算错"由 Attempt.errorTags 里的 note 承载，不靠 code 爆炸。

INSERT INTO "ErrorTag" ("id", "code", "label", "category", "description") VALUES
  ('et_concept_gap',     'CONCEPT_GAP',     '概念没懂',   'CONCEPT_GAP',     '用到的基础概念本身没掌握'),
  ('et_method_mismatch', 'METHOD_MISMATCH', '用错方法',   'METHOD_MISMATCH', '选了一个不适用这类题的方法'),
  ('et_condition_missed','CONDITION_MISSED','漏条件',     'CONDITION_MISSED','没看见或没用到题目给出的/隐含的条件'),
  ('et_compute_slip',    'COMPUTE_SLIP',    '算错',       'COMPUTE_SLIP',    '思路对，计算过程出错'),
  ('et_reading_slip',    'READING_SLIP',    '看错题',     'READING_SLIP',    '读题时把条件、符号或问题理解错了'),
  ('et_check_omitted',   'CHECK_OMITTED',   '没检查',     'CHECK_OMITTED',   '答案不完整或未经验证就交了')
ON CONFLICT ("code") DO NOTHING;
