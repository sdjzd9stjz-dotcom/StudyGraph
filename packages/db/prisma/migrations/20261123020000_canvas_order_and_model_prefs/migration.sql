-- =============================================================================
-- 首页画布排序 + 画布级模型配置（用户 2026-11-23 要求）
-- =============================================================================
-- 两条需求对应的两处结构变化：
--   1. 首页画布可以拖动排序 → Canvas.sortOrder
--   2. AI 配置成为每块画布独立的 → CanvasModelPref
--
-- 为什么排序用独立列而不是把 updatedAt 当顺序：
-- updatedAt 每次运行节点都会变，列表顺序会自己跳；用户手动排的顺序必须稳定。

ALTER TABLE "Canvas" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER;

CREATE TABLE IF NOT EXISTS "CanvasModelPref" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,

    CONSTRAINT "CanvasModelPref_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CanvasModelPref_canvasId_taskType_key"
    ON "CanvasModelPref"("canvasId", "taskType");
CREATE INDEX IF NOT EXISTS "CanvasModelPref_canvasId_idx" ON "CanvasModelPref"("canvasId");

ALTER TABLE "CanvasModelPref" ADD CONSTRAINT "CanvasModelPref_canvasId_fkey"
    FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CanvasModelPref" ADD CONSTRAINT "CanvasModelPref_credentialId_fkey"
    FOREIGN KEY ("credentialId") REFERENCES "UserCredential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 存量画布按创建时间给一个初始顺序，避免新列全为 NULL 时排序不稳定
UPDATE "Canvas" SET "sortOrder" = sub.rn
FROM (SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt") AS rn FROM "Canvas") AS sub
WHERE "Canvas"."id" = sub."id" AND "Canvas"."sortOrder" IS NULL;
