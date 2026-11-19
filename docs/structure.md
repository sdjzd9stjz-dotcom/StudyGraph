# 目录结构

> ✅ = 已落盘　⬜ = 计划中（按里程碑逐步创建，不一次性铺满）
> 最后更新：2026-11-18（M0）

```
studygraph/
├─ apps/
│  ├─ api/                                  ⬜ 后端：Fastify + BullMQ + MCP + LLM Gateway
│  │  ├─ src/
│  │  │  ├─ server.ts                       ⬜ 组装：plugins → routes → 优雅退出
│  │  │  ├─ env.ts                          ⬜ 环境变量 zod 校验（启动即失败，不留半配置）
│  │  │  ├─ plugins/
│  │  │  │  ├─ prisma.ts                    ⬜ 每请求作用域的 Prisma Client
│  │  │  │  ├─ auth.ts                      ⬜ PAT / OAuth2 → UserCtx + scope 守卫
│  │  │  │  ├─ sse.ts                       ⬜ /v1/runs/:id/events 事件流
│  │  │  │  ├─ errors.ts                    ⬜ 统一错误信封（含 400 端口类型错误）
│  │  │  │  └─ webhooks.ts                  ⬜ 五个事件的投递器
│  │  │  ├─ routes/
│  │  │  │  ├─ canvases.ts                  ⬜ POST /v1/canvases 等
│  │  │  │  ├─ nodes.ts                     ⬜ 创建节点、连线校验
│  │  │  │  ├─ runs.ts                      ⬜ POST /v1/nodes/:id/run、SSE
│  │  │  │  ├─ graph.ts                     ⬜ GET /graph?view=pipeline|knowledge|method
│  │  │  │  ├─ concepts.ts                  ⬜ due 列表、提交复习
│  │  │  │  ├─ methods.ts                   ⬜ 检索、practice
│  │  │  │  ├─ problems.ts                  ⬜ generate / attempts / due
│  │  │  │  ├─ papers.ts                    ⬜ assemble
│  │  │  │  ├─ analytics.ts                 ⬜ 错因分布
│  │  │  │  ├─ clone.ts                     ⬜ 只读克隆（保留署名）
│  │  │  │  ├─ chat-completions.ts          ⬜ OpenAI 兼容代理
│  │  │  │  └─ mcp.ts                       ⬜ MCP over HTTP 挂载点
│  │  │  ├─ nodes/                          ⭐ 节点执行器（契约唯一实现处）
│  │  │  │  ├─ contract.ts                  ⬜ NodeExecutor / NodeExecutorCtx / TokenUsage
│  │  │  │  ├─ registry.ts                  ⬜ registerExecutor / getExecutor / 启动自检
│  │  │  │  ├─ ports.ts                     ⬜ 端口类型表 + validateConnection()
│  │  │  │  ├─ fingerprint.ts               ⬜ sha256(上游 artifacts + params + 版本)
│  │  │  │  ├─ stale.ts                     ⬜ 指纹不一致 → 下游全链 STALE（不执行）
│  │  │  │  ├─ estimate.ts                  ⬜ 重跑前的 token 预估
│  │  │  │  ├─ execute.ts                   ⬜ 缓存命中 / 入队 / 计量 / 产物落库
│  │  │  │  └─ executors/
│  │  │  │     ├─ source.ts chunk.ts extract.ts card.ts prereq.ts
│  │  │  │     ├─ quiz.ts grade.ts review.ts gate.ts
│  │  │  │     ├─ probe.ts method.ts solve.ts diagnose.ts
│  │  │  │     └─ variant.ts distractor.ts check.ts paper.ts
│  │  │  │                                    （17 个，文件名 = type 小写）
│  │  │  ├─ domain/
│  │  │  │  ├─ concept.ts method.ts problem.ts paper.ts    ⬜ 领域操作
│  │  │  │  ├─ fsrs.ts                      ⬜ FSRS 状态推进（纯函数，可单测）
│  │  │  │  ├─ proficiency.ts               ⬜ 熟练度公式 v1（见 architecture.md §2.2）
│  │  │  │  ├─ error-tags.ts                ⬜ 错因 → 补丁映射
│  │  │  │  └─ graph/
│  │  │  │     ├─ dag.ts                    ✅ collectDownstream / collectUpstream / topoSort / CycleError
│  │  │  │     ├─ projection.ts             ⬜ 三视图投影（同一实体，不同边与布局）
│  │  │  │     └─ queries.ts                ⬜ 递归 CTE 封装（SQL 版已写在 packages/db/sql/downstream.sql）
│  │  │  ├─ llm/
│  │  │  │  ├─ gateway.ts                   ⬜ 统一抽象：complete() + 结构化输出
│  │  │  │  ├─ providers/openai.ts anthropic.ts           ⬜ 首期两个供应商
│  │  │  │  ├─ prefix-cache.ts              ⬜ 教材原文作 system 前缀
│  │  │  │  ├─ routing.ts                   ⬜ taskType → 模型
│  │  │  │  └─ byok.ts                      ⬜ 密钥解密，只在内存
│  │  │  ├─ queue/queues.ts worker.ts       ⬜ BullMQ
│  │  │  ├─ storage/
│  │  │  │  ├─ s3.ts                        ⬜ 对象存储
│  │  │  │  └─ parsers/pdf.ts pptx.ts web.ts audio.ts     ⬜ 解析 → 原文 + span 索引
│  │  │  ├─ mcp/server.ts tools/*.ts        ⬜ 同名工具暴露给外部 Agent
│  │  │  └─ auth/pat.ts oauth.ts scopes.ts  ⬜
│  │  ├─ test/
│  │  │  ├─ unit/                           ⬜ 指纹、拓扑排序、端口校验、FSRS、三检
│  │  │  └─ integration/                    ⬜ 节点链路、闸门
│  │  └─ package.json                       ⬜
│  └─ web/                                  ⬜ 前端：Next.js 14 App Router
│     ├─ app/
│     │  ├─ layout.tsx page.tsx             ⬜
│     │  ├─ c/[canvasId]/page.tsx           ⬜ 画布主界面（三视图切换）
│     │  ├─ today/page.tsx                  ⬜ 今日到期
│     │  ├─ problems/[problemId]/page.tsx   ⬜ 作答 + 路径对比
│     │  ├─ papers/[paperId]/page.tsx       ⬜ 组卷
│     │  └─ templates/page.tsx              ⬜ 模板市场
│     ├─ components/
│     │  ├─ canvas/CanvasShell.tsx NodeCard.tsx NodePalette.tsx
│     │  │           EdgeValidator.tsx StaleOverlay.tsx ViewSwitcher.tsx    ⬜
│     │  ├─ views/PipelineView.tsx KnowledgeView.tsx MethodView.tsx         ⬜
│     │  ├─ citation/CitationBadge.tsx SourceDrawer.tsx                     ⬜
│     │  ├─ method/MethodCard.tsx MethodSteps.tsx                           ⬜
│     │  ├─ problem/AttemptPanel.tsx PathDiff.tsx ErrorTagChips.tsx         ⬜
│     │  ├─ paper/PaperBuilder.tsx DifficultyHistogram.tsx CoverageGaps.tsx ⬜
│     │  └─ ui/                                                             ⬜
│     ├─ lib/api-client.ts sse.ts yjs/provider.ts yjs/node-map.ts            ⬜
│     └─ package.json                                                       ⬜
├─ packages/
│  ├─ contracts/src/                        🟡 前后端共享契约（不含 React）
│  │  ├─ index.ts                           ✅ 统一出口
│  │  ├─ node-types.ts                      ✅ 17 个类型 + 批次表
│  │  ├─ edges.ts                           ✅ 三种边语义（与 Prisma 逐字一致）
│  │  ├─ ports.ts                           ✅ 端口类型 + 入口端口 + validateConnection()
│  │  ├─ params/*.ts                        ⬜ 每节点 params schema（zod，M2 引入）
│  │  ├─ artifacts/*.ts                     ⬜ 产物 schema（含 SolutionStep）
│  │  ├─ error-tags.ts                      ⬜ 6 类错因 + 种子标签
│  │  ├─ scopes.ts                          ⬜ canvas:read / write / run:execute / problem:read
│  │  ├─ thresholds.ts                      ✅ proficiency 0.6 等阈值常量
│  │  └─ ../test/ports.test.ts              ✅ 27 条断言（N1–N5 / P1–P8 / schema 漂移）
│  ├─ db/
│  │  ├─ prisma/schema.prisma               ✅ 全量领域模型
│  │  ├─ prisma/migrations/
│  │  │  ├─ migration_lock.toml             ✅
│  │  │  └─ 20261118030000_init/migration.sql ✅ 由 migrate diff 生成，尚未在库上执行
│  │  ├─ sql/guards.sql                     ✅ CHECK / 触发器 / 审计视图，尚未执行
│  │  ├─ src/index.ts                       ⬜ PrismaClient 单例 + 类型再导出
│  │  └─ src/graph-sql.ts                   ⬜ 递归 CTE
│  └─ ui/src/                               ⬜ 设计令牌与共享原语
├─ scripts/
│  ├─ prisma.mjs                            ✅ Prisma CLI 启动器（见 runbook §3）
│  ├─ check-gates.ts                        ⬜ 扫审计视图 + 组卷缺口
│  ├─ seed.ts                               ⬜ 示例画布
│  └─ smoke.ts                              ⬜ 端到端冒烟
├─ docs/
│  ├─ architecture.md                       ✅ 选型理由与不变量
│  ├─ structure.md                          ✅ 本文件
│  ├─ runbook.md                            ✅ 环境、坑与命令
│  └─ milestone-1..6.md                     ⬜ 每个里程碑验收后写
├─ .env                                     ✅ 本地变量（已 gitignore）
├─ .env.example                             ✅
├─ .gitignore                               ✅
├─ pnpm-workspace.yaml                      ✅
├─ tsconfig.base.json                       ✅
├─ package.json                             ✅
├─ StudyGraph-Agent-Prompt.md               ✅ 原始需求，唯一指令来源
└─ README.md                                ✅
```

## 三条命名约定

1. **执行器文件名 = 节点 type 小写**：`type: 'extract'` ↔ `executors/extract.ts`。
   registry 启动时自检「17 个 type 是否都有实现」，缺一个就拒绝启动（防止半实现上线）。
2. **节点的三件套**：`packages/contracts/src/params/<type>.ts`（参数 schema）+
   `apps/api/src/nodes/executors/<type>.ts`（实现）+ `ports.ts` 里的端口声明。
   三者不同步时，`contracts` 的编译期类型会报错。
3. **`apps/api/src/nodes/...` 而不是顶层 `src/nodes/...`**：需求里写的路径是相对后端应用根目录的
   `src/nodes/executors/<type>.ts`，在 `apps/api` 内正是这个形状。

## 为什么是 monorepo

- `packages/contracts` 让 **UI 层与服务层共用同一份端口类型与参数 schema**——
  「端口不匹配在 UI 层与服务层双重拒绝」不可能靠两份手写实现保持一致。
- `packages/db` 独占 Prisma 与手写 SQL，避免每个 app 各自 `new PrismaClient()`。
- `packages/ui` 承载设计令牌，保证三个视图的视觉语言一致（例如 stale 一律琥珀色）。
