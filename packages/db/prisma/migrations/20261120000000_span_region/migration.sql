-- =============================================================================
-- Span.region（SG-SUP-007 §2.1）
-- =============================================================================
-- 备注页讲稿与幻灯片正文必须能区分：两者各自独立成文本基准，
-- 若拼进同一页文本，charStart 的基准就变了，所有已落库的 span 全部失效。
--
-- 单独一个 migration（已应用的那几个不动，校验和不变）。
-- =============================================================================

-- CreateEnum
CREATE TYPE "SpanRegion" AS ENUM ('PAGE', 'SLIDE', 'NOTES');

-- AlterTable
ALTER TABLE "Span" ADD COLUMN "region" "SpanRegion" NOT NULL DEFAULT 'PAGE';

-- DropIndex（唯一键要把 region 纳进来，否则同一页的正文与备注会撞唯一约束）
DROP INDEX "Span_sourceId_page_charStart_charEnd_key";

-- CreateIndex
CREATE UNIQUE INDEX "Span_sourceId_page_region_charStart_charEnd_key"
  ON "Span"("sourceId", "page", "region", "charStart", "charEnd");
