# StudyGraph

面向大学生的**节点式 AI 学习工作流平台**。把课堂材料拖进画布，用节点连线完成
`原料 → 理解 → 结构化 → 解题方法建模 → 训练 → 出题与组卷 → 复习`，
沉淀成一张可溯源、可复习、可协作的个人知识网络。

平台同等对待两种资产：

- **知识资产** `Concept` —— 概念是什么，携带**记忆掌握度**（FSRS 调度）
- **能力资产** `Method` —— 题目怎么做，携带**方法熟练度**（近期成功率 + 迁移成功率）

两者是两条独立的遗忘曲线，两套独立的状态变量，**永不合并**。
大多数笔记工具止步于"把材料变成卡片"，而学生真正的痛点是"上课听懂了，做题不会"——
`Method` 是解决这个痛点的载体。

---

## 当前状态

**M0 · 脚手架 + M1 开工前整改**（本仓库目前只有这些）

| 已交付 | 路径 |
| --- | --- |
| 全量领域模型（34 表 / 27 枚举 / 55 外键） | `packages/db/prisma/schema.prisma` |
| 初始迁移（表/枚举/外键/复合外键/扩展） | `packages/db/prisma/migrations/20261118030000_init/` |
| 物理约束迁移（7 CHECK / 6 触发器 / 4 视图，**已进 migration 链路**） | `packages/db/prisma/migrations/20261118030100_guards/` |
| SQL 验证器（无 Docker 时用 PGlite 跑迁移与负向用例） | `scripts/verify-sql.mjs` |
| 架构决策与不变量 | `docs/architecture.md` |
| 目录结构 | `docs/structure.md` |
| 运行手册（含本机 6 个环境坑） | `docs/runbook.md` |
| M1 设计决定（边写入入口、端口矩阵、删除策略） | `docs/milestone-1.md` |
| 监理指令 / 交付回报 / 独立验收 | `docs/指令/`、`docs/交付/`、`docs/验收/`（索引见 `docs/README.md`） |

**未实现**：任何 HTTP 接口、UI、节点执行器、LLM Gateway、队列、MCP。

已验证：schema 合法、Client 可生成、schema 能翻译成 PostgreSQL DDL、
两个 migration 在 PGlite(PostgreSQL 17 WASM) 上完整执行且四个正向/负向用例全绿。
未验证：尚未在 `pgvector/pgvector:pg16` 容器上执行（本机没有 Docker —— 这是当前唯一的阻塞项）。

---

## 快速开始

```bash
pnpm install --ignore-scripts   # 本机必须带 --ignore-scripts，原因见 docs/runbook.md
cp .env.example .env            # Windows: copy .env.example .env

pnpm db:validate                # 校验 schema
pnpm db:generate                # 生成 Prisma Client
pnpm db:ddl                     # 看 schema 会建出什么表（不连库）

docker compose up -d            # 需要 Docker Desktop：PG16+pgvector / Redis7 / MinIO
pnpm db:migrate                 # 应用迁移
```

## 目录

```
studygraph/
├─ apps/
│  ├─ api/        Fastify：REST + SSE + MCP + LLM Gateway + 17 个节点执行器
│  └─ web/        Next.js 14 App Router：画布、三视图、作答、组卷
├─ packages/
│  ├─ contracts/  前后端共享 zod 契约（端口类型、节点参数、SolutionStep）
│  ├─ db/         Prisma schema + 迁移 + 手写 SQL（递归 CTE、物理约束）
│  └─ ui/         设计令牌与共享原语
├─ scripts/       prisma CLI 启动器、审计、种子、冒烟
└─ docs/          architecture / structure / runbook / milestone-N
```

完整清单（含每个文件职责）见 [docs/structure.md](docs/structure.md)。

---

## 五条不可违反的硬约束

1. **溯源是物理约束** —— 任何 AI 生成的事实性论断必须携带 `source_span`；
   无引用的资产只能是 `UNVERIFIED`，不得进入卡片。数据库触发器强制这一点。
2. **执行必须显式触发** —— 上游变更只把下游标 `STALE`，绝不自动重跑；
   重跑前展示预计 token 消耗。
3. **写作类节点只给骨架** —— `Outline` / `Draft` 输出结构与证据槽位，不生成成段正文。
4. **出题必须过质量闸门** —— 可解性 / 判分确定性 / 无歧义三检，
   任一失败标 `REJECTED` 并附理由，不得入库。
5. **每个干扰项必须诊断一个错因** —— 错误选项绑定 `ErrorTag`，禁止凑数选项。

设计理由与实现落点见 [docs/architecture.md](docs/architecture.md)。

## 里程碑

| 里程碑 | 范围 | 状态 |
| --- | --- | --- |
| M1 | 画布底座：schema 落地、画布 CRUD、17 个占位卡片、端口校验连线 | 待开始 |
| M2 | 执行链路：registry + BullMQ、source/chunk/extract/card、溯源抽屉、指纹缓存 | 未开始 |
| M3 | 知识视图：prereq、图投影、掌握度热力、FSRS 调度、今日到期 | 未开始 |
| M4 | 开放能力：REST + SSE、MCP server、PAT、克隆 | 未开始 |
| M5 | 解题方法：probe/method/solve/diagnose、method 视图、双熟练度、错题看板 | 未开始 |
| M6 | 出题组卷：variant/distractor/check/paper、题库、组卷页 | 未开始 |

## 技术栈

Next.js 14 App Router · TypeScript · Tailwind · @xyflow/react · Yjs ·
Fastify · Prisma 6 · PostgreSQL 16 + pgvector · BullMQ + Redis · S3 兼容存储 ·
KaTeX（前端渲染）+ MathML（存储）

不上 Neo4j、不直连厂商 API、不用 OT —— 理由见 [docs/architecture.md §5](docs/architecture.md)。
