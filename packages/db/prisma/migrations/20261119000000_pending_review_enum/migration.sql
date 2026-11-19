-- =============================================================================
-- migration 1/2 · 只加枚举值（SG-SUP-010 §2.1）
-- =============================================================================
-- PostgreSQL 不允许在同一个事务里"加枚举值 + 立刻使用"，会报
--   unsafe use of new value "PENDING_REVIEW" of enum type "VerificationStatus"
-- 所以拆成两个 migration：这一份只加值，下一份才用它。
--
-- 位置放在 'MERGED' 之前，保持"未验证 → 已验证 → 待审 → 已合并"的语义顺序
-- （枚举比较按声明顺序，不影响判断逻辑，但读 pg_enum 时更直观）。
-- =============================================================================

ALTER TYPE "VerificationStatus" ADD VALUE IF NOT EXISTS 'PENDING_REVIEW' BEFORE 'MERGED';
