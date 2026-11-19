# StudyGraph 架构决策与不变量

> 本文件记录「为什么这样做」。可执行的事实以 `packages/db/prisma/schema.prisma`、
> `packages/db/prisma/migrations/` 与 `docs/milestone-N.md` 为准。
> 最后更新：2026-11-18（M1 开工前整改）

---

## 0. 今天真正验证过什么

| 项 | 状态 | 证据 |
| --- | --- | --- |
| Prisma schema 语法与关系完整 | ✅ 已验证 | `prisma validate` → valid |
| Prisma Client 可生成 | ✅ 已验证 | `prisma generate` |
| schema 能翻译成 PostgreSQL DDL | ✅ 已验证 | `prisma migrate diff` → 34 表 / 27 枚举 |
| 三个 migration 在 **PG16 容器**上执行 | ✅ 已验证 | `_prisma_migrations` 三行、`applied_steps_count=1`、无回滚 |
| CHECK / 触发器 / 视图计数 | ✅ 已验证（PG16） | 8 / 6 / 4（自环约束加入后 CHECK 由 7 变 8） |
| 溯源触发器拒绝无引用 VERIFIED | ✅ 已验证（PG16） | `ERROR: Concept ... cannot be VERIFIED without at least one source span citation` |
| 自环边被拒 | ✅ 已验证（PG16） | `violates check constraint "edge_no_self_loop"` |
| 跨画布连边被数据库拒绝 | ✅ 已验证（复合外键） | `Edge_canvasId_toNodeId_fkey` |
| 纯函数与 SQL 下游语义一致 | ✅ 已验证（PG16 集成测试） | `downstream-equivalence.test.ts` 2 pass |
| 任何 HTTP / UI / 节点执行器 | ❌ 未实现 | M1 起逐步落地 |

**不要把上表的 ❌ 当成已完成。** 里程碑文档只写验收通过的行为。
PGlite 仍是本地快速回归工具，但**不再作为验收证据**（SG-SUP-002 §0）。

---

## 1. 领域模型只有四个概念

| 概念 | 职责 | 携带的状态 |
| --- | --- | --- |
| `Node` | 一道加工工序，有输入输出端口 | `status` / `fingerprint` |
| `Edge` | 节点图连线，只有三种语义 | `kind` ∈ {DERIVED_FROM, PREREQUISITE, CITES} |
| `Concept` | 知识单元 | `mastery` / `dueAt` / `fsrsState` |
| `Method` | 解题工序 | `proficiency` / `lastUsedAt` |

其余表都是这四者的证据层（`Span`、`Artifact`、`Run`）、关系层（`ConceptEdge`、
`MethodEdge`、`ConceptCitation`）或评价层（`Attempt`、`MethodApplication`）。

**`Edge.kind` 的枚举值在 DDL 里就是三值**：

```sql
CREATE TYPE "EdgeKind" AS ENUM ('DERIVED_FROM', 'PREREQUISITE', 'CITES');
```

新增关系语义必须新建关系表（`ConceptEdge` / `MethodEdge` 就是两次这样做的产物）。
把概念关系塞进 `Edge` 会让节点图失去「管线」语义，两个视图会互相污染。

---

## 2. 双熟练度：两条曲线，两套调度

这不是 UI 上的两个进度条，而是两套独立的数学模型。

### 2.1 记忆（Concept）— FSRS

- 状态：`fsrsState`（stability、difficulty、state、step…）+ `dueAt` + `reps` / `lapses`
- 调度单位：下一次复习的日期
- 展示量 `mastery`：把 stability 单调映射到 0..1，`mastery = S / (S + 10)`（S 以天计）
  - S = 3 天 → 0.23；S = 10 天 → 0.50；S = 30 天 → 0.75
  - 这个映射只用于「知识视图的节点半径」与排序，不参与调度决策。调度只看 `dueAt` 与 `fsrsState`。
- 每次复习写一条 `ConceptReview`，保留复习前后 stability / difficulty，
  以便后续用真实数据拟合 FSRS 参数（而不是一直用默认权重）。

### 2.2 解题（Method）— 近期成功率 + 迁移成功率

`proficiency` 是派生量，不是手填字段。原始观测在 `MethodApplication`：

```
每条观测的权重   w_i = exp(-Δdays_i / 21) × (isTransfer_i ? 1.5 : 1.0)
proficiency     = clamp( (α₀ + Σ_{isCorrect} w_i) / (α₀ + β₀ + Σ_all w_i), 0.02, 0.98 )
α₀ = β₀ = 2     （Beta(2,2) 先验，半衰期 21 天）
```

性质与验收对应关系：

| 场景 | 计算 | 结果 |
| --- | --- | --- |
| 初始（无观测） | 2/4 | 0.50 |
| 两个不同情境各成功一次（近期） | (2 + 1.5 + 1.5) / (4 + 3) | 0.71 ↑ |
| 连续两次误用（近期） | 2 / (4 + 2) | 0.33 ↓ |
| 三个月没碰过 | 权重衰减 → 回到 0.50 | 手感淡化，但不判为「不会」 |

三个设计取舍：

1. **回到 0.5 而不是 0**：久不使用是「不确定」，不是「失败」。降到 0 会让少人复习的学生被系统误判。
2. **迁移加权 1.5**：同一情境重复练会高估能力；`isTransfer` 由 `contextKey`（题型 + 概念组合 + 表征形式）是否变化判定。
3. **误用单独计数**：`isMisuse` 由 `diagnose` 输出 `METHOD_MISMATCH` 时回写，直接压低 proficiency，不等同于「做错」。

**`proficiency` 低于 0.6 的方法在方法视图带虚线边框**——这是阈值，不是硬编码在组件里的魔法数，
放在 `packages/contracts` 的常量里。

### 2.3 为什么绝不合并

一个概念可以记得很牢但完全不会用（mastery 高、proficiency 低 → 该练方法）；
一个方法可以背得滚瓜烂熟但换情境失效（迁移成功率低 → 该练边界）。
合并成一个数后，平台就只剩下「你行/你不行」，而失去了「你缺哪一环」的诊断能力——
这正是本产品存在的理由。

---

## 3. 溯源是物理约束

三层防线，任何一层单独都不够：

**第一层 · 数据层（不变量）**
`ConceptCitation` / `MethodCitation` / `ProblemCitation` 三张引用表，
把资产钉到 `Span(sourceId, page, charStart, charEnd)` 上。
`20261118030100_guards` 里的两组触发器：

- `BEFORE INSERT OR UPDATE OF status`：`status = 'VERIFIED'` 时若引用数为 0，写入直接失败；
- `AFTER DELETE`（挂在三张引用表上）：删掉最后一条引用后，把父实体降级回 `UNVERIFIED`。

只有前者是不够的——**删引用同样会让 VERIFIED 失守**，而降级方向不会被前者拦住。
两个用例都在 `scripts/verify-sql.mjs` 里。

**第二层 · 服务层（解析即校验）**
executor 产出的每条论断都带 `spanIds`；`SpanResolver` 解析失败（span 不存在、
原文校验和不符）的论断标记 `UNVERIFIED`，并不允许进入 `ConceptCard` / `MethodCard`。
`Span.text` 是解析时的快照，`Source.checksum` 用于发现「原文变了、引用已漂移」。

**第三层 · 出口层（导出即附带）**
`Outline` / `Draft` 导出附 AI 参与度元数据：哪些段落由模型生成、引用了哪些 span。
没有引用的卡片不进入导出。

**禁止实现的路径**：任何「模型直接生成概念卡正文」的捷径。
`card` 节点的输入必须是 `extract` 的 claims（已带 spanIds），不允许从零生成。

### 3.1 span 偏移相对于什么文本（SG-SUP-004 §3.5 要求现在定死）

**相对于「该页的纯文本」**（选项 a）。精确约定：

| 项 | 约定 |
| --- | --- |
| 页文本 | 该页所有文本项按阅读顺序拼接，**不做空白压缩、不做字符替换、不做 Unicode 规范化** |
| `page` | 从 1 开始 |
| `charStart` / `charEnd` | 页内字符偏移（UTF-16 code unit，与 JS `String.prototype.slice` 一致），`[start, end)` 左闭右开 |
| 恒等式 | `span.text === pageText.slice(charStart, charEnd)` |

为什么不用整篇文档的偏移：它依赖页间分隔符的约定，换一个 PDF 解析器就会整体错位；
页内偏移是自包含的，第三方拿同一页文本就能复现。

为什么不用"规范化后的字符串"：规范化规则一调整，历史 span 全部漂移，而且**漂移是静默的**——
界面照常高亮，只是高亮到了另一段话上。这比报错危险得多。

校验口径：`apps/api/src/spans/resolver.ts` 的 `verifySpan()` 逐字符比对，
并在 `packages/contracts/src/artifacts/span.ts` 的注释里重复了同一段定义——
两处必须是同一段话，改一处就要改另一处。

---

## 4. 执行语义：显式触发 + 指纹缓存

### 4.0 stale 传播只沿 `DERIVED_FROM`（SG-SUP-002 §2.1）

三种边里只有 `DERIVED_FROM` 是**数据依赖**：下游的产物是用上游的产物算出来的。
另外两种不是：

| 边 | 含义 | 为什么不该触发 stale |
| --- | --- | --- |
| `CITES` | 节点引用某段原文 span | 引用的是 `Span`，不是上游节点的产物。原文变没变由 `Source.checksum` 与 span 校验判定；上游节点重跑不改变已引用的原文，凭什么让下游重算 |
| `PREREQUISITE` | 概念先修顺序 | 它是知识结构（学习路径），不是数据流。若沿它传播，"补一条先修边"这种纯知识操作会把整条加工链标脏，既烧钱又误导学生"我的卡片坏了" |

因此：

- 纯函数 `collectDownstream` / `collectUpstream` / `topoSort` 默认 `STALE_EDGE_KINDS = ['DERIVED_FROM']`
- SQL `packages/db/sql/downstream.sql` 同样只沿 `DERIVED_FROM`
- 需要"看所有连线"的场景（画布高亮、边列表）显式传 `{ kinds: ALL_EDGE_KINDS }`
- 两边一致性不靠人工保证：`apps/api/test/integration/downstream-equivalence.test.ts`
  在真实 PG16 上把同一张图跑两遍做 `deepEqual`

> 这条决定同时修掉了 SG-SUP-002 指出的 P1-1：此前纯函数默认三种全走、SQL 只走派生，
> 同一张图会得出两个答案——而且两边各自看都"对"。

### 4.1 指纹

```
fingerprint = sha256(
  canonicalJson(上游 artifacts 的 hash 列表)
  + canonicalJson(node.params)
  + modelVersion
  + promptVersion
)
```

- 上游 run 成功 → 重算下游每个节点的指纹 → 与 `Node.fingerprint` 不等则 `status = STALE`
- **STALE 只改状态，不入队、不调用模型**（验收：改 chunk 参数后下游变 stale 且不消耗 token）
- 用户点执行 → 若 `fingerprint` 命中某次成功 run，直接复用产物，`Run.cacheHit = true`，`tokensIn/Out = 0`

### 4.2 成本前置

执行前返回 `estimatedTokensIn/Out`（由上次同类 run 的用量 + 本次输入规模估算），
`gate` 节点把批量执行的估算汇总给用户确认后才入队。`Run.status = AWAITING_APPROVAL` 就是这个状态。

### 4.3 事件流

`GET /v1/runs/:id/events` 走 SSE，事件类型固定为
`run.queued` / `run.started` / `run.progress` / `run.completed` / `run.failed`。
进度与 token 增量走 SSE，不轮询。

---

## 5. 技术选型与理由

### 5.1 不引入 Neo4j：PostgreSQL 邻接表 + 递归 CTE + pgvector

- 规模：单个学生的图是**数千节点**量级；一门课的概念先修链深度通常 ≤ 5。
- 递归 CTE 足够表达「所有先修」「下游影响面」「路径」三类查询，且与事务、权限、备份同源。
- 语义邻接用 `pgvector`：`Concept.embedding vector(1536)` + HNSW 余弦索引，
  「和这个概念相近的还有哪些」不需要另一套图库。
- 运维代价：少一个数据库就少一类故障、一套备份、一份权限模型。学生版产品最贵的是运维注意力。

代价：复杂图算法（社区发现、中心性）需要写 SQL 或用 Node 侧内存计算。
当前 17 个节点没有这类需求；真需要时另建离线分析表，而不是引入图数据库。

### 5.2 自建 LLM Gateway

前端禁止直连厂商 API。三个理由：

1. **收口**：学生 BYOK 与校园额度必须走同一处计量与限额（`UsageRecord` + `ProviderCredential`）。
2. **前缀缓存**：教材原文作为 system 前缀稳定复现，命中厂商前缀缓存可省 60%+ 输入成本。
   缓存键按 `(sourceId, 章节范围, promptVersion)` 组织，同一份材料的所有节点共享。
3. **路由**：切片、抽取、判分这类任务路由到小模型（便宜、够用）；
   `probe` / `method` / `solve` / `variant` 这类需要推理的路由到前沿模型。

统一接口（M2 实现）：

```ts
interface LLMGateway {
  complete(req: {
    taskType: 'chunk' | 'extract' | 'quiz' | 'probe' | 'method' | 'solve' | 'variant' | 'check' | 'judge'
    messages: Message[]
    jsonSchema?: JSONSchema      // 结构化输出强制约束
    cachePrefixKey?: string      // 前缀缓存键
    user: UserCtx                // 决定用谁的额度/密钥
  }): Promise<{ data: unknown; usage: TokenUsage }>
}
```

`/v1/chat/completions` 兼容层复用同一条链路，因此 MCP 客户端与第三方 Agent 也受同样的计量与路由约束。

### 5.3 CRDT 而非 OT

小组作业以异步、弱网、离线编辑为主。Yjs 的 `y-map` 天然适配「节点图 = 一堆带 id 的实体」，
合并冲突时不需要服务端串行化。落库策略：增量更新走 Redis 广播，定期压缩成快照写 `CanvasDoc.ystate`，
避免每次拖拽都打数据库。

### 5.4 版本锁定与理由

| 依赖 | 版本 | 理由 |
| --- | --- | --- |
| Next.js | 14.2.x | 甲方硬约束（App Router）。注意 14.x 已进入维护期，升级 15/16 会改动 App Router 约定，不在本期范围 |
| Prisma | 6.19.3 | 7/8 起客户端生成器与驱动适配器契约变化大；M1 前不引入不确定性。已实测 validate/generate 通过 |
| PostgreSQL | 16 + pgvector | `Unsupported("vector(1536)")` 需要 pgvector 扩展 |
| Node.js | ≥22.11 | 本机 26.13.1 实测可用（Prisma 6 官方矩阵未覆盖 26，迁移环节待验证） |

### 5.5 对象存储选型：SeaweedFS（替代 MinIO）

**结论**：`docker compose` 的 `s3` 服务用 `chrislusf/seaweedfs`，通过 S3 网关提供对象存储。
`S3_ENDPOINT` 仍是唯一入口配置，**换回 MinIO 或换成真实 S3 只改配置与镜像，代码不动**。

为什么可以：规格写的是「S3 兼容存储」，没有点名厂商。SeaweedFS 的 S3 网关实现同一套协议，
`ObjectStore`（`apps/api/src/storage/object-store.ts`）只依赖协议，`put/get/deleteMany`
在本地实测通过（65536 字节往返 sha256 一致、删除后读回 `NoSuchKey`）。

为什么不是 MinIO（2026-11-19 实测，全部记录在 `milestone-2.md`）：

| 尝试 | 结果 |
| --- | --- |
| `docker pull minio/minio:latest` | `repository does not exist`（已迁离 Docker Hub） |
| `quay.io/minio/minio` | HEAD manifest `401 UNAUTHORIZED`（token 认证过不了本机代理链路） |
| `bitnami/minio` | `not found` |
| `dl.min.io/.../minio.exe` | HTTP 410 Gone |

**健康检查标准**：`curl -sf http://127.0.0.1:8333/` 必须成功。
不要探 `/status`（404，会让容器永远 unhealthy），也不要写 `exit 0` 敷衍。
`docker compose ps` 里三个服务都必须显示 `(healthy)`。

### 5.6 PDF 解析库选型：`unpdf`

硬指标是**逐页文本 + 可复现的字符偏移**（`architecture.md` §3.1 定义了偏移口径）。
选 `unpdf` 的理由：

- 纯 JS（打包了 pdfjs 的 node 构建），不需要 canvas/DOM，可直接在 Fastify 进程里跑
- `getDocumentProxy()` → `numPages` 与逐页 `getTextContent()`，页内文本项顺序稳定，
  我们据此拼接页文本并按 `[start,end)` 切 span
- 不需要额外的 native 依赖（`pdfjs-dist` 在 ESM/Node 组合下还要处理 worker 路径）

代价：`unpdf` 不做版面分析（双栏会按内容流顺序拼接），M2 的定位是"能拿到稳定偏移"，
版面纠偏留到需要时再评估。扫描版（无文字层）会被判为解析失败并返回
`SOURCE_HAS_NO_TEXT_LAYER`，**不生成任何内容**。

### 5.7 前缀缓存键在各厂商的落点

`cachePrefixKey` 由调用方按 `(sourceId, 章节范围, promptVersion)` 组织，落到适配层后：

| 厂商 | 落点 | 说明 |
| --- | --- | --- |
| OpenAI | 请求体 `prompt_cache_key` | 同键的请求共享前缀缓存；**键不同 → 请求体必然不同**（可观察） |
| Anthropic | 不传键，靠 `system[].cache_control: ephemeral` | Anthropic 的缓存维度就是 system 前缀内容本身，没有独立的键参数；伪造一个厂商不认识的字段比不传更糟 |

---

## 6. 图投影：一份数据，三个视图

`GET /v1/canvases/:id/graph?view=pipeline|knowledge|method` 返回**同一批实体**，
差别只在边的子集与布局算法：

| 视图 | 主体 | 边 | 布局 | 视觉编码 |
| --- | --- | --- | --- | --- |
| pipeline | `Node` | `Edge`（三种语义全展示） | 有向 DAG，左→右 | stale 琥珀虚线链，error 红色 |
| knowledge | `Concept` | `ConceptEdge` | d3-force | 半径 = mastery，颜色 = dueAt 紧迫度 |
| method | `Method` | `MethodEdge` | 分层（SPECIALIZES 向上） | 外环 = proficiency，< 0.6 虚线边框 |

**id 在三个视图之间不变。** 切换视图只换布局与边渲染，不重新取数；
布局结果缓存在 `CanvasViewLayout`，避免每次切换节点乱跳。

---

## 7. 出题闸门与错因闭环

```
variant ──► distractor ──► check ──► (VERIFIED) 题库
                            │
                            └──► (REJECTED + rejectReason) 不入库
```

- `check` 三检：可解性 / 判分确定性 / 表述无歧义，任一失败即 `REJECTED`。
- 选择题每个错误选项必须绑定 `ErrorTag`，且错项不得量级荒谬
  （`|option - answer| / |answer| > 10` 视为凑数）。
- `Attempt.errorTags` 存 `[{ code, stepOrder, note }]`——错因要落到具体步骤，
  否则 `diagnose` 无法给出「哪一步该补什么」。
- 错因 → 补丁的映射是产品逻辑，放在 `packages/contracts`，不让每个页面各写一套。

### 7.1 与规格的三处有意偏离（已与监理确认）

| 偏离 | 规格写法 | 实际 | 理由 |
| --- | --- | --- | --- |
| `Problem.options` 可空 | `options Json`（必填） | `Json?` | 证明题/计算题没有选项。选择题"≥2 个选项"由 `problem_choice_has_options` CHECK 保证，不是靠可空字段放水 |
| `Attempt.isCorrect` 可空 | `Bool` | `Boolean?` | `RUBRIC` 判分是异步/人工的，作答当下无法确定对错；`null` 明确表示"待判" |
| `Edge.canvasId` + 复合外键 | 无此字段 | 有 | 规格没有"创建边"端点，需要显式写入入口；没有 `canvasId` 时判断跨画布要 join 两次 Node，服务层漏写就是越权连边 |

另外两处收窄（不涉及规格文本，属实现决策）：`CanvasRole` 只有 `EDITOR/VIEWER`（所有权由
`Canvas.ownerId` 唯一表达）；`Edge` 增加 `fromPort/toPort`（端口校验的落点）。

---

## 8. 数据层守卫

Prisma 表达不了的东西在 guard migrations 里（目前两份）：
`20261118030100_guards` 与 `20261119000000_edge_no_self_loop`。
`packages/db/sql/guards.sql` 是两者的聚合副本，`scripts/check-guards-sync.mjs` 按语句流比对防漂移。
**它们是 migration，不是手工脚本**——`migrate deploy` 与 shadow database 都自带这些约束。

| 守卫 | 形式 | 防的是什么 |
| --- | --- | --- |
| mastery / proficiency ∈ [0,1]、difficulty ∈ [0,5] | CHECK | 越界值让诊断失去意义 |
| span 区间有序 | CHECK | 高亮指向不存在的位置 |
| REJECTED 必须有理由、VERIFIED 必须无理由 | CHECK | 「悄悄入库」 |
| 选择题必须 ≥2 个选项 | CHECK | 坏数据进 UI |
| **边不得自环** | CHECK（20261119000000） | topoSort 无解、stale 在自身收敛不了 |
| VERIFIED 资产必须有 ≥1 条引用 | 触发器（写入） | 无源生成 |
| 引用被删光后自动降级 | 触发器（删除） | 删引用绕过溯源约束 |
| 跨画布连边 | 复合外键 | 越权连边 |
| 干扰项缺 errorTag | 审计视图 | 凑数选项 |
| 试卷 report 里有 gaps 仍标 READY | 审计视图 | 静默补齐缺口 |
| `steps[].conceptIds` 与 `MethodConcept` 不一致 | 审计视图 | 两份数据悄悄漂移 |

计数（PG16 实测）：CHECK **8**、触发器 6、视图 4。

审计视图不阻塞写入，由 `scripts/check-gates.ts` 与 CI 扫描——写入路径的性能不该被审计拖累。

**硬约束与 SQL 的对应关系**（可逐条查）：

| 约束 | 落点 |
| --- | --- |
| 溯源是物理约束 | 三张 citation 表的写入/删除触发器 |
| Edge 只有三种语义 | `CREATE TYPE "EdgeKind"` 三值 |
| 干扰项必须绑定错因 | `v_problem_distractor_without_error_tag` |
| 出题必须过闸门 | `Problem.status` + `problem_rejected_has_reason` |
| 组卷不许静默补齐 | `v_paper_with_coverage_gap` |

---

## 9. 已知风险与未决项

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| `migrate dev` 会生成 `DROP INDEX` 删掉手写索引 | 语义检索静默失效 | ✅ 已加 `scripts/check-drift.mjs`（检测即 exit 1），见 runbook §4.2 |
| 沙箱禁止管道式子进程 | Prisma 引擎命令曾需放宽权限 | ✅ 当前会话为 danger-full-access，已可直接跑 `migrate deploy` |
| 纯函数与 SQL 的下游语义漂移 | stale 传播在两处给出不同答案 | ✅ 已统一为只沿 `DERIVED_FROM`，并有真库等价性测试 |
| pgvector 维度写死 1536 | 换 embedding 模型要迁移 | `Concept.embeddingModel` 记录来源，切换时批量重建 |
| Next 14 生态老化 | 装依赖可能撞 peer 冲突 | M1 安装时验证（本轮未动前端依赖） |
| Prisma 6 + Node 26 非官方矩阵 | — | ✅ 已在 PG16 上跑通 `migrate deploy` |

---

## 10. 关键查询：递归 CTE 取先修链

这条查询是「不上 Neo4j」的底气所在（先用 `packages/db/sql/` 里的手写 SQL，
M3 再封成 `domain/graph` 的函数）：

```sql
WITH RECURSIVE prereq_chain AS (
  SELECT c.id, c.name, c."mastery", 0 AS depth, ARRAY[c.id] AS path
  FROM "Concept" c
  WHERE c.id = $1
  UNION ALL
  SELECT parent.id, parent.name, parent."mastery", pc.depth + 1, pc.path || parent.id
  FROM prereq_chain pc
  JOIN "ConceptEdge" e
    ON e."toConceptId" = pc.id
   AND e.kind = 'PREREQUISITE'
   AND e.status = 'CONFIRMED'
  JOIN "Concept" parent ON parent.id = e."fromConceptId"
  WHERE pc.depth < 8
    AND NOT parent.id = ANY(pc.path)   -- 环路保护
)
SELECT * FROM prereq_chain ORDER BY depth;
```

`path` 数组既防环，也能直接反查出学习路径顺序。
