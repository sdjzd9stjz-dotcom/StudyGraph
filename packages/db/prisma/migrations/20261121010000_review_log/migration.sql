-- =============================================================================
-- M3 · 复习记账（FSRS 调度）
-- =============================================================================
-- 为什么单独一张表而不是只更新 Concept：FSRS 参数拟合要用历史
-- （哪次评分、当时的间隔与可提取性），Concept 上只留最新状态。
-- 「今日到期」的统计也依赖这张表判断今天已经复习过几次。
--
-- DDL 由 `prisma migrate diff --from-empty --to-schema-datamodel` 生成后裁剪。

-- CreateTable
CREATE TABLE "ReviewLog" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "grade" "ReviewGrade" NOT NULL,
    "stateBefore" "FsrsCardState" NOT NULL DEFAULT 'NEW',
    "stabilityBefore" DOUBLE PRECISION,
    "difficultyBefore" DOUBLE PRECISION,
    "elapsedDays" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stateAfter" "FsrsCardState" NOT NULL,
    "stabilityAfter" DOUBLE PRECISION NOT NULL,
    "difficultyAfter" DOUBLE PRECISION NOT NULL,
    "scheduledDays" DOUBLE PRECISION NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewLog_conceptId_createdAt_idx" ON "ReviewLog"("conceptId", "createdAt");
CREATE INDEX "ReviewLog_userId_createdAt_idx" ON "ReviewLog"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReviewLog" ADD CONSTRAINT "ReviewLog_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewLog" ADD CONSTRAINT "ReviewLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
