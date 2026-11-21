-- =============================================================================
-- 知识网络：两种新节点 + 节点对话落库（用户 2026-11-21 要求）
-- =============================================================================
-- 用户的原话：「连线意指将连线进入的节点的所有对话的总结作为上下文，
-- 确保最后可以形成类似于思维导图一样的知识网络」。
--
-- 因此这一版有两件事必须进库：
--   1. 节点对话（NodeMessage）—— 对话要参与下游执行与指纹，不能只存在浏览器里
--   2. 两种节点：深入理解（DEEPEN）与导出讲义（LECTURE）
--
-- PostgreSQL 12+ 允许在事务里 ADD VALUE，只要同一事务内**不使用**新值；
-- 本迁移只加枚举、建表，不写任何带新枚举值的数据。

ALTER TYPE "NodeType" ADD VALUE IF NOT EXISTS 'DEEPEN';
ALTER TYPE "NodeType" ADD VALUE IF NOT EXISTS 'LECTURE';

ALTER TYPE "ArtifactKind" ADD VALUE IF NOT EXISTS 'DEEP_INSIGHT';
ALTER TYPE "ArtifactKind" ADD VALUE IF NOT EXISTS 'LECTURE_DOC';

-- CreateTable
CREATE TABLE "NodeMessage" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NodeMessage_nodeId_createdAt_idx" ON "NodeMessage"("nodeId", "createdAt");

-- AddForeignKey
ALTER TABLE "NodeMessage" ADD CONSTRAINT "NodeMessage_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
