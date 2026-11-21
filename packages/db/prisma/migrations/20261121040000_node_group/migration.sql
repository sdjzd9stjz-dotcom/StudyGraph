-- =============================================================================
-- 画布分组：把一部分节点打包成一个上下文单元（用户 2026-11-21 要求）
-- =============================================================================
-- 为什么不做成新节点类型：规格写死「共 17 个节点类型，不要多做」。
-- 分组是画布层的视图组织 + 依赖聚合，不是执行器，因此用独立表而不是塞进 NodeType。
--
-- 三张表的职责：
--   NodeGroup       分组的标题、位置、摘要
--   NodeGroupMember 哪些节点属于这个组（复合主键，天然防重复）
--   NodeGroupLink   哪个节点把这个组当作上下文

-- CreateTable
CREATE TABLE "NodeGroup" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "posX" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "posY" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "summary" JSONB,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeGroupMember" (
    "groupId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,

    CONSTRAINT "NodeGroupMember_pkey" PRIMARY KEY ("groupId","nodeId")
);

-- CreateTable
CREATE TABLE "NodeGroupLink" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeGroupLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NodeGroup_canvasId_idx" ON "NodeGroup"("canvasId");
CREATE INDEX "NodeGroupMember_nodeId_idx" ON "NodeGroupMember"("nodeId");
CREATE INDEX "NodeGroupLink_nodeId_idx" ON "NodeGroupLink"("nodeId");
CREATE UNIQUE INDEX "NodeGroupLink_groupId_nodeId_key" ON "NodeGroupLink"("groupId", "nodeId");

-- AddForeignKey
ALTER TABLE "NodeGroup" ADD CONSTRAINT "NodeGroup_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NodeGroup" ADD CONSTRAINT "NodeGroup_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NodeGroupMember" ADD CONSTRAINT "NodeGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "NodeGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NodeGroupMember" ADD CONSTRAINT "NodeGroupMember_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NodeGroupLink" ADD CONSTRAINT "NodeGroupLink_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "NodeGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NodeGroupLink" ADD CONSTRAINT "NodeGroupLink_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
