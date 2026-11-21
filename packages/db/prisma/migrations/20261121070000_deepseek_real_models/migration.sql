-- =============================================================================
-- 修正 DeepSeek 的模型名（种子写错了）
-- =============================================================================
-- 当初种子填的是 deepseek-chat / deepseek-reasoner，但官方 /models 现在返回的是
-- deepseek-flash 与 deepseek-v4-pro。后果很实际：
--   · 界面上出现两个点了必然失败的"模型"
--   · 默认路由也指向它们，所有真正调模型的任务一起报错
--
-- 以官方返回为准，不猜。用户拉一次模型列表就能看到真实名字。

-- 1. 删掉两个不存在的模型
DELETE FROM "ProviderModel" WHERE "id" IN ('pm_ds_chat', 'pm_ds_reasoner');

-- 2. 补上真实模型（用 upsert 语义：用户已拉取过的同名行不重复插，只确保可用）
INSERT INTO "ProviderModel" ("id", "providerId", "modelId", "displayName", "contextWindow", "capabilities", "enabled") VALUES
  ('pm_ds_flash', 'prov_deepseek', 'deepseek-flash',  'DeepSeek Flash',   65536, '{"jsonObject": true}',                     true),
  ('pm_ds_v4pro', 'prov_deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro',  65536, '{"jsonObject": true, "reasoning": true}',   true)
ON CONFLICT ("providerId", "modelId") DO UPDATE
  SET "enabled" = true;

-- 3. 指向已删模型的偏好要清掉。
--    留着它不会"保持原来的选择"，只会让那个任务每次运行都失败；
--    清掉之后该任务回到默认路由（已改成真实模型）。
DELETE FROM "UserModelPref" WHERE "modelId" IN ('deepseek-chat', 'deepseek-reasoner');
