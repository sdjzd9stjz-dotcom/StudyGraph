# M1 · 画布底座

> **状态：整改期（§2 闸门已完成，画布 CRUD 未开始）**
> 本文件在 M1 通过验收前，只写**设计决定**与**待验证清单**，不写任何"已完成"。
> 每一项验收通过后，把命令与输出补进下面的「验收记录」。

---

## 0. 进度

| 项 | 状态 |
| --- | --- |
| Prisma schema 全量落地 | ✅ 已验收（SG-SUP-001 §1） |
| 三个 migration 在 PG16 上应用 | ✅ 已应用（含 `20261119000000_edge_no_self_loop`） |
| 自环边约束 | ✅ PG16 实测拒绝（`edge_no_self_loop`） |
| 迁移漂移防护 | ✅ `scripts/check-drift.mjs` 实测 exit 1 |
| stale 语义定死（只沿 DERIVED_FROM） | ✅ 纯函数 / SQL / 文档 / 等价性测试四者一致 |
| 画布 CRUD | ✅ POST/GET/DELETE 实测（§6.5） |
| 节点创建 / PATCH 位置 | ✅ 17 种 type 全通过；位置落库复查一致 |
| 17 个占位卡片 + 拖拽 | 🟡 调色板与卡片已实现并 SSR 验证；拖拽为客户端行为，无浏览器环境未实测 |
| 端口矩阵（契约层） | ✅ 17×2 已定 + 27 条断言通过（`packages/contracts`） |
| 端口校验（后端 400） | ✅ N1–N5 实测 400，绕开 UI（§6.3） |
| stale 下游收集（纯函数） | ✅ 13 条断言（`dag.ts`） |
| stale 下游收集（SQL 递归 CTE） | ✅ PG16 等价性 2 条断言 |
| `mark-stale` 接口 | ✅ 只标不跑，Run 行数不变（§6.6） |
| `docs/milestone-1.md` | ✅ 本文件（§5/§6 已回填） |

---

## 1. 边的写入入口（SG-SUP-001 §3.3）

规格的 REST 清单里没有"创建边"，但 M1 的全部验收（端口校验、后端 400、stale 传播）
都建立在"有一条边被创建"上。**决定：新增与节点对称的端点。**

```
POST /v1/canvases/:canvasId/edges
```

**请求体**

```json
{
  "fromNodeId": "n_chunk_1",
  "toNodeId": "n_extract_1",
  "kind": "DERIVED_FROM",
  "fromPort": "out",
  "toPort": "in"
}
```

- `kind` 省略时默认 `DERIVED_FROM`；`fromPort`/`toPort` 省略时用节点该侧唯一端口的默认名。
- `canvasId` **只从路径取**，不接受请求体传入——否则客户端可以指定别人的画布。

**校验顺序（服务层，写在插入之前）**

| # | 检查 | 失败 errorCode | HTTP |
| --- | --- | --- | --- |
| 1 | 画布存在且调用者有 `canvas:write` | `CANVAS_NOT_FOUND` / `FORBIDDEN` | 404 / 403 |
| 2 | 两端节点存在且属于该画布 | `NODE_NOT_IN_CANVAS` | 400 |
| 3 | `fromNodeId !== toNodeId` | `EDGE_SELF_LOOP` | 400 |
| 4 | 端口名在节点声明中存在 | `EDGE_PORT_NOT_FOUND` | 400 |
| 5 | 端口类型兼容（见 §3 矩阵） | `EDGE_PORT_TYPE_MISMATCH` | **400** |
| 6 | 同 `(from,to,kind)` 未重复 | `EDGE_DUPLICATE` | 409 |

**统一错误信封**（M1 起全站沿用）：

```json
{
  "error": {
    "code": "EDGE_PORT_TYPE_MISMATCH",
    "message": "端口类型不匹配：source.out(SourceDoc) → card.in(ConceptClaims)",
    "details": {
      "fromPort": "out",
      "fromPortType": "SourceDoc",
      "toPort": "in",
      "toPortType": "ConceptClaims"
    }
  }
}
```

**同画布约束由数据库兜底**：`Edge.canvasId` + 复合外键
`(canvasId, fromNodeId) → Node(canvasId, id)`（`Node @@unique([canvasId, id])`）。
服务层漏写检查时，跨画布连边也会被外键拒绝——实测见
`scripts/verify-sql.mjs` 的「3.3 跨画布连边」段落。

### 待补：运行中的 curl（阻塞在数据库）

本机没有 Docker，起不了 PostgreSQL，服务无法启动。DB 就绪后本条验收补：

```bash
curl -sS -X POST "$API_BASE_URL/v1/canvases/$CV/edges" \
  -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
  -d '{"fromNodeId":"n_source_1","toNodeId":"n_card_1","kind":"DERIVED_FROM","fromPort":"out","toPort":"in"}'
# 预期：400 + error.code = EDGE_PORT_TYPE_MISMATCH
```

---

## 2. 删除策略（SG-SUP-001 §8.1 的回答）

**M1 采用物理删除 + 显式对象存储清理**，不引入软删。

理由：

1. `onDelete: Cascade` 已经覆盖 Node / Run / Artifact 的库内级联，软删会让每个查询都要带
   `deletedAt IS NULL`，而 M1 的图投影、拓扑排序、stale 传播都会因此多一层过滤——出错成本高。
2. 孤儿对象的根因不是"删除是物理的"，而是"删库不删桶"。所以在删除路由里**先算 key 清单、
   再删库、再删桶**，桶删除失败只记 `orphanObjects` 计数并打日志，不回滚事务（对象存储不是事务资源）。
3. S3 对象 key 设计成 `canvas/<canvasId>/...`，M4 提供一次 `scripts/gc-orphans.ts` 做兜底扫描。

待办：M1 的 `DELETE /v1/canvases/:id` 必须实现上述顺序，并在 milestone 里记录一次实测。

---

## 3. 端口类型矩阵（17 个节点）

规格没有定义端口类型，这是本次实施决策。**判定规则只有一条：`from` 端口类型必须与 `to` 端口类型同名。**

端口命名：简单节点用 `in` / `out`；需要两路输入的节点用语义名（`problem` / `solution`）。

**入口端口（⤓）**：数据来自画布外部（粘贴题目 / 提交作答），不由连线供给。
向入口端口连线必须 400 `EDGE_PORT_EXTERNAL`，UI 上渲染成"上传/粘贴槽"而不是连接点。
这是写单测时逼出来的约束——`ProblemInput` / `AnswerRecord` 没有任何节点能产出，
如果允许连线就会产生一条永远拿不到数据的死边。

| # | type | 输入端口 → 类型 | 输出端口 → 类型 | 语义 |
| --- | --- | --- | --- | --- |
| 1 | `source` | —（文件由 params/上传提供） | `out` → `SourceDoc` | 原文 + span 索引 |
| 2 | `chunk` | `in` ← `SourceDoc` | `out` → `ChunkSet` | 语义切片 |
| 3 | `extract` | `in` ← `ChunkSet` | `out` → `ConceptClaims` | 概念论断（带 spanIds） |
| 4 | `card` | `in` ← `ConceptClaims` | `out` → `ConceptCardSet` | 概念卡（已入库、已校验引用） |
| 5 | `prereq` | `in` ← `ConceptCardSet` | `out` → `GraphPatch` | 先修关系补丁（PROPOSED） |
| 6 | `quiz` | `in` ← `ConceptCardSet` | `out` → `ProblemSet` | 概念自测题草稿 |
| 7 | `grade` | `in` ⤓ `AnswerRecord` | `out` → `GradeResult` | 判分 + 错因 |
| 8 | `review` | `in` ← `GradeResult` | `out` → `ReviewPlan` | FSRS 调度写入 |
| 9 | `gate` | `in` ← `ProblemSet` | `out` → `ProblemSet` | 人工成本/质量闸门（通过后原样放行） |
| 10 | `probe` | `problem` ⤓ `ProblemInput` | `out` → `ProbeProfile` | 题型/考点/隐含条件 |
| 11 | `method` | `problem` ⤓ `ProblemInput`，`solution` ← `SolutionTrace` | `out` → `MethodCard` | 解法抽取 |
| 12 | `solve` | `problem` ⤓ `ProblemInput` | `out` → `SolutionTrace` | 分步解法（不可跳步） |
| 13 | `diagnose` | `in` ← `GradeResult` | `out` → `Diagnosis` | 错因归因 + 补丁 |
| 14 | `variant` | `in` ← `ProblemSet` | `out` → `ProblemSet` | 六维变式 |
| 15 | `distractor` | `in` ← `ProblemSet` | `out` → `ProblemSet` | 干扰项 + ErrorTag |
| 16 | `check` | `in` ← `ProblemSet` | `out` → `VerifiedProblems` | 三检闸门 |
| 17 | `paper` | `in` ← `VerifiedProblems` | `out` → `PaperSpec` | 组卷 |

终端产物（`GraphPatch` / `ProbeProfile` / `ReviewPlan` / `Diagnosis` / `MethodCard` / `PaperSpec`）
不连下游：它们落库或落卡片库，不是边上的中间态。

### 必须 400 的负向用例（前端拦 + 后端 400）

| # | from | to | 期望 errorCode |
| --- | --- | --- | --- |
| N1 | `source.out`（SourceDoc） | `card.in`（ConceptClaims） | `EDGE_PORT_TYPE_MISMATCH` |
| N2 | `chunk.out`（ChunkSet） | `paper.in`（VerifiedProblems） | `EDGE_PORT_TYPE_MISMATCH` |
| N3 | `extract.out`（ConceptClaims） | `check.in`（ProblemSet） | `EDGE_PORT_TYPE_MISMATCH` |
| N4 | `card.out`（ConceptCardSet） | `chunk.in`（SourceDoc） | `EDGE_PORT_TYPE_MISMATCH` |
| N5 | `chunk.out`（ChunkSet） | `solve.problem`（ProblemInput ⤓） | `EDGE_PORT_EXTERNAL` |

> N3 原定 `extract.out → grade.in`，但 `grade.in` 是入口端口，会先命中 `EDGE_PORT_EXTERNAL`。
> 入口端口判定在类型判定之前，报错更贴近真实原因。

### 合法用例（正例，防止"全拒绝也算通过"）

| # | from → to | 端口类型 |
| --- | --- | --- |
| P1 | `source.out` → `chunk.in` | SourceDoc |
| P2 | `chunk.out` → `extract.in` | ChunkSet |
| P3 | `extract.out` → `card.in` | ConceptClaims |
| P4 | `card.out` → `prereq.in` | ConceptCardSet |
| P5 | `card.out` → `quiz.in` | ConceptCardSet |
| P6 | `solve.out` → `method.solution` | SolutionTrace |
| P7 | `variant.out` → `check.in` | ProblemSet |
| P8 | `check.out` → `paper.in` | VerifiedProblems |

> P5 原定 `problem.out → solve.problem`，但 `ProblemInput` 没有生产节点（见上文入口端口），
> 改为 `card.out → quiz.in`。

**实现与验证**：矩阵在 `packages/contracts/src/ports.ts`，`validateConnection()` 是纯函数；
`packages/contracts/test/ports.test.ts` 27 条断言覆盖 N1–N5、P1–P8、入口端口结构性约束、
以及与 `schema.prisma` 的 `NodeType` / `EdgeKind` 逐字比对。

---

## 4. stale 传播（SG-SUP-001 §7.2① + SG-SUP-002 §2.1）

M1 不实现执行，但必须先有**能跑的**下游收集：

- **语义（已定死）**：只沿 `DERIVED_FROM`。`CITES` 引用原文、`PREREQUISITE` 是知识结构，
  都不是数据依赖。理由写在 `docs/architecture.md` §4.0（SG-SUP-002 要求"要么采纳要么反驳"，这里采纳）
- 存储层：`Edge @@index([fromNodeId])` 已就位
- 纯函数：`apps/api/src/domain/graph/dag.ts` 的 `collectDownstream` / `collectUpstream` / `topoSort`，
  默认 `STALE_EDGE_KINDS = ['DERIVED_FROM']`；要看全部关系显式传 `ALL_EDGE_KINDS`
- SQL：`packages/db/sql/downstream.sql` 同样只走 `DERIVED_FROM`，输出 `depth` 与 `truncated`
  （深度上限 64 会置 `truncated=true`，不再静默截断）
- 单测：造 `A → B → C`，产出必须**就是** `[B, C]`（`assert.deepEqual`）
- 等价性：`apps/api/test/integration/downstream-equivalence.test.ts` 在真实 PG16 上
  同一张图跑两边（含 `CITES` / `PREREQUISITE` 边）做 `deepEqual`
- 结果：单测 13 条 + 等价性 2 条全绿；`CycleError.cycle` 已改为真实环路径（P2-4）

---

## 5. 验收清单（SG-SUP-003 §5 逐条）

### 5.1 环境与启动

- [x] `node scripts/seed-pat.ts` 签发 token，明文打印一次，库里只有 hash
- [x] `SELECT "tokenHash"` 的值 ≠ 明文（等于 `sha256(明文)`，64 位十六进制）
- [x] `GET /health` → 200 `{"status":"ok","db":"up"}`

### 5.2 鉴权

- [x] 无 token → 401 `UNAUTHENTICATED`
- [x] 伪造 token → 401 `UNAUTHENTICATED`
- [x] 只读 token 调 `POST /v1/canvases` → **403 `INSUFFICIENT_SCOPE`**
- [x] 吊销后 → 401 `TOKEN_REVOKED`；过期 → 401 `TOKEN_EXPIRED`

### 5.3 画布 CRUD

- [x] `POST /v1/canvases` → 201，返回 `id`
- [x] `GET /v1/canvases/:id` → 200，含 `nodes` / `edges`
- [x] `DELETE /v1/canvases/:id` → 204，且 `Node` / `Edge` 归零（级联）
- [x] 访问别人的画布 → 404（不是 403，不泄露存在性）

### 5.4 节点

- [x] 17 种 type 全部 201，`status = DRAFT`
- [x] 非法 type → 400 `NODE_TYPE_INVALID`
- [x] `PATCH /v1/nodes/:id` 落库位置（`posX=321,posY=654` 复查一致）

### 5.5 边（核心）

- [x] N1–N4 → 400 `EDGE_PORT_TYPE_MISMATCH`；N5 → 400 `EDGE_PORT_EXTERNAL`
- [x] 自环 → 400 `EDGE_SELF_LOOP`
- [x] 跨画布节点 → 400 `NODE_NOT_IN_CANVAS`
- [x] 重复边 → 409 `EDGE_DUPLICATE`
- [x] 并发两条相同边 → 一个 201 一个 409，库里只有 1 行
- [x] body 带 `canvasId` → 400 `CANVAS_ID_IN_BODY`
- [x] P1–P8 八条全部 201，`Edge` 行数 +8
- [x] 绕过服务层直接 psql 插跨画布边 → 复合外键拒绝

### 5.6 stale

- [x] `A→B→C`（全 `DERIVED_FROM`），`mark-stale A` 后 A、B、C 都是 `STALE`
- [x] `Run` 表行数前后不变（0 → 0），且响应里 `runCreated: false`
- [x] `A--CITES--> D`，`mark-stale A` 后 D 仍是 `DRAFT`

### 5.7 前端

- [x] 画布页 200，调色板 SSR 出 17 个 `data-testid="palette-item"`
- [x] 位置落库（PATCH 200 → GET 读回 321/654）
- [x] stale 琥珀 `#f59e0b` 出现 6 次，红色 `#ef4444` 0 次
- [x] 入口端口在页面上登记为"上传/粘贴槽（无连接点）"，3 个（SOLVE / PROBE / GRADE）
- ⚠ 节点卡片的拖拽与连线是 ReactFlow 客户端行为，无浏览器环境下只能验证 SSR 部分与 API 契约

### 5.8 文档

- [x] 本节逐条勾选，§6 记录命令与输出
- [x] 未通过项保持 `[ ]`（目前没有）

---

## 6. 验收记录（M1 主体，2026-11-19）

全部命令在 `D:\ai学习辅助工作流搭建` 执行；API 监听 `127.0.0.1:3001`，Web 监听 `127.0.0.1:3000`。

### 6.1 token 只存哈希

```
$ node scripts/seed-pat.ts --email=dev@studygraph.local --name=dev --scopes=canvas:read,canvas:write,run:execute,problem:read
   token     : sg_pat_iVRhkAWc-q7Perl-lV9cNqvgfm_YnRLEBYqL1CH1zls
   tokenHash : 434d851c720518ae…  ← 库里存的是这个 64 位十六进制
```

```
库中存的是 sha256(明文)   期望=ca40fb8c…a69a  实际=ca40fb8c…a69a   ✔（另一枚测试 token）
明文不在库里             期望=true            实际=true            ✔
tokenHash 长度 64        期望=64              实际=64              ✔
```

### 6.2 鉴权四种情况

```
✔ 未带 Authorization        期望=401 实际=401
✔ 伪造 token               期望=401 实际=401
✔ 只读 token 写画布          期望=403 实际=403  {"code":"INSUFFICIENT_SCOPE"}
✔ 已吊销 token             期望=401 实际=401  {"code":"TOKEN_REVOKED"}
✔ 已过期 token             期望=401 实际=401  {"code":"TOKEN_EXPIRED"}
```

### 6.3 边：五条负向 + 其他负向

```
✔ N1 source.out→card.in        期望=400 实际=400  {"code":"EDGE_PORT_TYPE_MISMATCH"}
✔ N2 chunk.out→paper.in        期望=400 实际=400  {"code":"EDGE_PORT_TYPE_MISMATCH"}
✔ N3 extract.out→check.in      期望=400 实际=400  {"code":"EDGE_PORT_TYPE_MISMATCH"}
✔ N4 card.out→chunk.in         期望=400 实际=400  {"code":"EDGE_PORT_TYPE_MISMATCH"}
✔ N5 chunk.out→solve.problem   期望=400 实际=400  {"code":"EDGE_PORT_EXTERNAL"}
✔ 自环                          期望=400 实际=400  {"code":"EDGE_SELF_LOOP"}
✔ body 带 canvasId              期望=400 实际=400  {"code":"CANVAS_ID_IN_BODY"}
✔ 重复边                        期望=409 实际=409  {"code":"EDGE_DUPLICATE"}
✔ 并发同一条边                   期望=201,409 实际=201,409
✔ 并发后库中该边只有一行           期望=1 实际=1
```

### 6.4 绕过服务层（psql 直插）

```
ERROR:  insert or update on table "Edge" violates foreign key constraint "Edge_canvasId_toNodeId_fkey"
DETAIL:  Key (canvasId, toNodeId)=(cv_a, n_b1) is not present in table "Node".
ERROR:  new row for relation "Edge" violates check constraint "edge_no_self_loop"
edges_in_cv_a=1        ← 同一批次里那条合法边插入成功
```

### 6.5 正例与级联

```
✔ P1…P8 全部 201，边总数期望=8 实际=8
✔ 删除画布 204；级联后 Node=0、Edge=0
```

### 6.6 stale

```
✔ mark-stale 请求 200  {"staleNodeIds": […], "runCreated": false}
✔ A/B/C 全部 STALE
✔ CITES 下游 D 未被标 STALE（仍是 DRAFT）
✔ Run 表行数不变（0 → 0）
```

### 6.7 前端 SSR

```
status=200 bytes=22482
paletteItems=17  nodeChips=7  staleChips=3  draftChips=4
externalSlots=3  amber(#f59e0b)=6  red(#ef4444)=0  has17Types=true
```

画布页：`http://127.0.0.1:3000/c/cmwmvv3o20041q5cce796wiye`
