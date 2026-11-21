-- =============================================================================
-- M4.5 · 新能力（F2 Skill 指令包 / G1 对话式编排草案）
-- =============================================================================
-- 两张核心表 + 一张绑定表 + 一张草案表。
--
-- 关键约束落在结构上而不是文档里：
--   · NodeSkill 用复合主键，重复绑定写不进去
--   · Skill.version 每次改动 +1，且**进指纹**（否则"加了 skill 却命中旧缓存"）
--   · GraphDraft 与 Canvas 分开存：草案不是画布，确认才落盘
--
-- DDL 由 `prisma migrate diff --from-empty --to-schema-datamodel` 生成后裁剪。

-- CreateEnum
CREATE TYPE "SkillScope" AS ENUM ('BUILTIN', 'USER');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'DISCARDED');

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "assets" JSONB,
    "scope" "SkillScope" NOT NULL,
    "ownerId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeSkill" (
    "nodeId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,

    CONSTRAINT "NodeSkill_pkey" PRIMARY KEY ("nodeId","skillId")
);

-- CreateTable
CREATE TABLE "GraphDraft" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "proposal" JSONB NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'PROPOSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GraphDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Skill_slug_key" ON "Skill"("slug");
CREATE INDEX "Skill_scope_enabled_idx" ON "Skill"("scope", "enabled");
CREATE INDEX "Skill_ownerId_idx" ON "Skill"("ownerId");
CREATE INDEX "NodeSkill_skillId_idx" ON "NodeSkill"("skillId");
CREATE INDEX "GraphDraft_canvasId_status_idx" ON "GraphDraft"("canvasId", "status");
CREATE INDEX "GraphDraft_ownerId_idx" ON "GraphDraft"("ownerId");

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NodeSkill" ADD CONSTRAINT "NodeSkill_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NodeSkill" ADD CONSTRAINT "NodeSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GraphDraft" ADD CONSTRAINT "GraphDraft_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GraphDraft" ADD CONSTRAINT "GraphDraft_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- 内置 Skill（BUILTIN，运维维护）
-- =============================================================================
-- 只放"确实能改善某类任务做法"的说明，不放泛泛而谈的鼓励语。
INSERT INTO "Skill" ("id", "slug", "name", "description", "instructions", "scope", "enabled", "version", "updatedAt") VALUES
  (
    'skill_citation_strict',
    'citation-strict',
    '严格溯源',
    '适用于概念抽取：要求每条结论都指向原文的具体位置。',
    E'抽取概念时遵守以下规则：\n1. 每条结论必须能在原文中逐字找到依据；找不到就丢弃，不要改写成"大意如此"。\n2. 定义要尽量保留原文措辞，不要用同义词替换专业术语。\n3. 如果原文用的是公式或符号，原样保留，不要转成文字描述。',
    'BUILTIN',
    true,
    1,
    now()
  ),
  (
    'skill_chinese_math',
    'chinese-math-notation',
    '中文数学表述',
    '适用于中文数学课件：统一符号与术语的写法。',
    E'处理中文数学内容时遵守：\n1. 数学符号保持原样（如 x∈R、a>0 且 a≠1），不要改写成中文。\n2. 术语用国内教材的通行译法（如"定义域""值域""单调性"）。\n3. 涉及区间时用标准写法 [a, b] 与 (a, b)，不要写成"从 a 到 b"。',
    'BUILTIN',
    true,
    1,
    now()
  );
