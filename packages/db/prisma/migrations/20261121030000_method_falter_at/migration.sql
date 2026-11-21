-- =============================================================================
-- M5 · Method.falterAt（最容易出错的地方）
-- =============================================================================
-- 规格的 method 节点输出里点名要有 falterAt（"trigger / conditions / steps / checks / falterAt"），
-- 但数据模型只建了前四个。单独补一份迁移而不是改旧迁移：
-- 旧的那个已经应用并记了 checksum，改一个字节 `migrate deploy` 就会失败。

ALTER TABLE "Method" ADD COLUMN "falterAt" TEXT;
