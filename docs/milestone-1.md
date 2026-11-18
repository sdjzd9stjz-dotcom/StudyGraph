# M1 · 画布底座

> **状态：未开工（开工前整改阶段）**
> 本文件在 M1 通过验收前，只写**设计决定**与**待验证清单**，不写任何"已完成"。
> 每一项验收通过后，把命令与输出补进下面的「验收记录」。

---

## 0. 进度

| 项 | 状态 |
| --- | --- |
| Prisma schema 全量落地 | ✅ 已验收（SG-SUP-001 §1） |
| guards 进 migration 链路 | ✅ SQL 已验证（PGlite/PG17），⏳ 待容器复验 |
| 画布 CRUD | ⬜ 未开始 |
| 17 个占位卡片 + 拖拽 | ⬜ 未开始 |
| 端口校验（前端 + 后端 400） | 🟡 端口矩阵已定（见 §3），代码未写 |
| `docs/milestone-1.md` | 🟡 本文件 |

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

| # | type | 输入端口 → 类型 | 输出端口 → 类型 | 语义 |
| --- | --- | --- | --- | --- |
| 1 | `source` | —（文件由 params/上传提供） | `out` → `SourceDoc` | 原文 + span 索引 |
| 2 | `chunk` | `in` ← `SourceDoc` | `out` → `ChunkSet` | 语义切片 |
| 3 | `extract` | `in` ← `ChunkSet` | `out` → `ConceptClaims` | 概念论断（带 spanIds） |
| 4 | `card` | `in` ← `ConceptClaims` | `out` → `ConceptCardSet` | 概念卡（已入库、已校验引用） |
| 5 | `prereq` | `in` ← `ConceptCardSet` | `out` → `GraphPatch` | 先修关系补丁（PROPOSED） |
| 6 | `quiz` | `in` ← `ConceptCardSet` | `out` → `ProblemSet` | 概念自测题草稿 |
| 7 | `grade` | `in` ← `AnswerRecord` | `out` → `GradeResult` | 判分 + 错因 |
| 8 | `review` | `in` ← `GradeResult` | `out` → `ReviewPlan` | FSRS 调度写入 |
| 9 | `gate` | `in` ← `ProblemSet` | `out` → `ProblemSet` | 人工成本/质量闸门（通过后原样放行） |
| 10 | `probe` | `problem` ← `ProblemInput` | `out` → `ProbeProfile` | 题型/考点/隐含条件 |
| 11 | `method` | `problem` ← `ProblemInput`，`solution` ← `SolutionTrace` | `out` → `MethodCard` | 解法抽取 |
| 12 | `solve` | `problem` ← `ProblemInput` | `out` → `SolutionTrace` | 分步解法（不可跳步） |
| 13 | `diagnose` | `in` ← `GradeResult` | `out` → `Diagnosis` | 错因归因 + 补丁 |
| 14 | `variant` | `in` ← `ProblemSet` | `out` → `ProblemSet` | 六维变式 |
| 15 | `distractor` | `in` ← `ProblemSet` | `out` → `ProblemSet` | 干扰项 + ErrorTag |
| 16 | `check` | `in` ← `ProblemSet` | `out` → `VerifiedProblems` | 三检闸门 |
| 17 | `paper` | `in` ← `VerifiedProblems` | `out` → `PaperSpec` | 组卷 |

### 必须 400 的负向用例（前端拦 + 后端 400）

| # | from | to | 期望 |
| --- | --- | --- | --- |
| N1 | `source.out`（SourceDoc） | `card.in`（ConceptClaims） | 400 `EDGE_PORT_TYPE_MISMATCH` |
| N2 | `chunk.out`（ChunkSet） | `paper.in`（VerifiedProblems） | 400 `EDGE_PORT_TYPE_MISMATCH` |
| N3 | `extract.out`（ConceptClaims） | `grade.in`（AnswerRecord） | 400 `EDGE_PORT_TYPE_MISMATCH` |
| N4 | `card.out`（ConceptCardSet） | `chunk.in`（SourceDoc） | 400 `EDGE_PORT_TYPE_MISMATCH` |

### 合法用例（正例，防止"全拒绝也算通过"）

| # | from | to |
| --- | --- | --- |
| P1 | `source.out` → `chunk.in` | SourceDoc |
| P2 | `chunk.out` → `extract.in` | ChunkSet |
| P3 | `extract.out` → `card.in` | ConceptClaims |
| P4 | `card.out` → `prereq.in` | ConceptCardSet |
| P5 | `problem.out` → `solve.problem` | ProblemInput |
| P6 | `solve.out` → `method.solution` | SolutionTrace |
| P7 | `variant.out` → `check.in` | ProblemSet |
| P8 | `check.out` → `paper.in` | VerifiedProblems |

---

## 4. stale 传播（SG-SUP-001 §7.2①）

M1 不实现执行，但必须先有**能跑的**下游收集：

- 存储层：`Edge @@index([fromNodeId])` 已就位
- 查询：`WITH RECURSIVE` 沿 `Edge` 反向展开，环路用 `path` 数组保护
- 单测：造 `A → B → C`，`collectDownstream(A)` 必须 `toEqual(expect.arrayContaining([B, C]))`

实现位置：`apps/api/src/domain/graph/dag.ts`（M1 内），SQL 版本在 `packages/db/prisma` 侧注释留档。

---

## 5. 验收清单（全部待勾）

- [ ] `POST /v1/canvases` → 201，返回 id
- [ ] `GET /v1/canvases/:id` → 200，包含节点与边
- [ ] 17 个节点类型都能拖上画布（占位卡片，不执行）
- [ ] N1–N4 四个负向用例：前端拦截 + 后端 400（curl 绕开 UI 实测）
- [ ] P1–P8 八个正例全部 201
- [ ] `collectDownstream` 单测通过（A→B→C）
- [ ] 跨画布连边被拒绝（服务层 400 + DB 外键兜底）
- [ ] `DELETE /v1/canvases/:id` 后 `pg_constraint` 无孤儿行、MinIO 无残留对象

---

## 6. 验收记录

（通过后逐条补命令与输出，未通过的不写）
