# StudyGraph 搭建提示词

> 用途：把本文件完整交给具备文件系统与终端权限的编码 Agent（Claude Code / Cursor / Codex 等），作为项目开发的唯一指令来源。
> 版本：v1.0　｜　适用范围：从零实现到大二里程碑

---

## 角色

你是一名全栈工程师，负责从零实现一个面向大学生的「节点式 AI 学习工作流平台」，代号 **StudyGraph**。你拥有完整的前后端代码库控制权。

你的产出必须是可运行的代码，不是设计文档。任何"设计完成但未实现"的内容都要明确标注，不得伪装成已完成。

---

## 产品定义

学生把课堂材料（PDF/PPT/网页/录音）与习题拖入画布，通过节点连线完成以下加工流程，最终沉淀为一张可溯源、可复习、可协作的个人知识网络：

```
原料 → 理解 → 结构化 → 解题方法建模 → 训练 → 出题与组卷 → 复习
```

平台的两个核心资产必须同等对待：

| 资产 | 含义 | 载体 |
| --- | --- | --- |
| **知识资产** | 概念是什么 | `Concept` |
| **能力资产** | 题目怎么做 | `Method` |

**能力资产是本平台区别于普通笔记工具的关键。** 大多数同类产品止步于"把材料变成卡片"，而学生真正的痛点是"上课听懂了，做题不会"。平台必须把解题方法作为一等公民建模，而不是附属于概念的备注文本。

---

## 领域概念（只有四个）

| 概念 | 定义 |
| --- | --- |
| **节点（Node）** | 一道加工工序，有明确输入输出端口 |
| **边（Edge）** | 节点图上的连线，只有三种语义 |
| **概念（Concept）** | 知识单元，携带**记忆掌握度** |
| **方法（Method）** | 解题工序，携带**方法熟练度** |

### 边的三种语义

节点图的 `Edge.kind` 枚举固定为：

- `DERIVED_FROM` —— 派生关系，保证重放与溯源
- `PREREQUISITE` —— 先修关系，构成 DAG，用于排学习路径
- `CITES` —— 引用关系，指向**原文 span**（文件 + 页码 + 字符区间）

### 关键设计：双熟练度模型

**记忆与解题是两条独立的遗忘曲线，必须用两套状态变量分别建模。**

- 概念用 FSRS 算法调度复习（`mastery` / `dueAt` / `fsrsState`）
- 方法用「近期调用成功率 + 迁移成功率」计算熟练度（`proficiency` / `lastUsedAt`）

**禁止把两者合并为单一 mastery 字段。** 一个概念可以记得很牢但完全不会用；一个方法可以背得滚瓜烂熟但换个情境就失效。合并会摧毁平台的核心诊断能力。

### 概念关系的位置

概念之间的关系**不放在 Edge 上**，而放在独立的 `ConceptEdge` 中：

```
PREREQUISITE | CONTRAST | CONTAINS | APPLIES_TO | VARIANT_OF
```

这样节点图保持三边语义的简洁性，知识网可以自由扩展。

> **不允许为了新功能给 `Edge` 加第四种 kind。** 需要新的关系语义时，新增独立的关系表。

---

## 五条不可违反的硬约束

### 1. 溯源是物理约束

任何 AI 生成的事实性论断必须携带 `source_span` 引用；解析失败的论断标为 `UNVERIFIED` 并禁止进入 `ConceptCard` / `MethodCard`。

禁止实现任何"无源生成"路径。这一条决定了教师是否敢让学生使用本产品。

### 2. 执行必须显式触发

上游节点变更时，下游节点标记为 `stale`，**绝不自动重跑**。执行必须由用户显式触发，且重跑前展示预计 token 消耗。

### 3. 写作类节点只给骨架

`Outline` / `Draft` 只输出结构与证据槽位，不生成成段正文。导出时必须附 AI 参与度元数据（哪些内容由模型生成、哪些证据被引用）。

### 4. 出题必须过质量闸门

任何题目进入题库前必须通过 `check` 节点三检：

| 检查项 | 判定标准 |
| --- | --- |
| **可解性** | 存在解，且解题路径在给定条件下可达 |
| **判分确定性** | 答案唯一，或判分规则可机械执行（无"酌情给分"） |
| **表述无歧义** | 不依赖隐含假设、不含未定义符号、单位与量纲自洽 |

三检任一失败则该题标 `REJECTED` 并附 `rejectReason`，**不得入库**。

### 5. 每个干扰项必须诊断一个错因

选择题的每个错误选项都要绑定一个 `ErrorTag`，判分时据此产出错因。

禁止生成"明显凑数"的干扰项（如数值量级荒谬、与题干单位不符、语法不通的选项）。一个干扰项如果没有诊断价值，就不该存在。

---

## 技术栈（不得替换）

| 层 | 选型 |
| --- | --- |
| 前端 | Next.js 14 App Router + TypeScript + Tailwind + `@xyflow/react` + Yjs（CRDT 协作） |
| 后端 | Node.js + Fastify + Prisma |
| 数据库 | PostgreSQL + pgvector |
| 对象存储 | S3 兼容存储 |
| 图谱 | PostgreSQL 邻接表 + 递归 CTE（**禁止引入 Neo4j**） |
| 队列 | BullMQ + Redis |
| 公式 | KaTeX（前端渲染）+ MathML（存储标准形） |
| 模型 | 自建统一 LLM Gateway 抽象层，首期接 2 个供应商，支持 BYOK 与前缀缓存 |

**选型理由（写进 `docs/architecture.md`）：**

- **不上 Neo4j**：单个学生的图规模在数千节点量级，PG 邻接表 + 递归 CTE 完全够用，`pgvector` 补语义邻接。少一个运维组件，少一类故障。
- **自建 LLM Gateway**：前端禁止直连厂商 API。理由有三——① 学生 BYOK 与校园额度需要统一收口；② 教材原文做 system 前缀可实现前缀缓存，省 60%+ 成本；③ 切片、抽取、判分这类任务须路由到小模型。
- **CRDT 而非 OT**：小组作业以异步、弱网、离线编辑为主，Yjs 的 `y-map` 天然适配节点图。

---

## 领域模型（先写 schema，再写代码）

```prisma
// ============ 画布与执行 ============
model Canvas   { id, ownerId, title, createdAt }
model Node     { id, canvasId, type, params Json,
                 status enum(DRAFT,READY,RUNNING,STALE,ERROR),
                 fingerprint, posX, posY }
model Edge     { id, fromNodeId, toNodeId,
                 kind enum(DERIVED_FROM,PREREQUISITE,CITES) }
model Run      { id, nodeId, status, modelUsed, tokensIn, tokensOut, startedAt, endedAt }
model Artifact { id, nodeId, runId, kind, s3Key, structured Json }
model Source   { id, nodeId, filename, mimeType, pageCount, parsedAt }
model Span     { id, sourceId, page, charStart, charEnd, text }

// ============ 知识资产 ============
model Concept  { id, canvasId, name, definition, mastery Float,
                 dueAt DateTime, fsrsState Json }
model ConceptEdge { id, fromConceptId, toConceptId,
                 kind enum(PREREQUISITE,CONTRAST,CONTAINS,APPLIES_TO,VARIANT_OF) }

// ============ 能力资产 ============
model Method   { id, canvasId, name,
                 trigger Json,        // 识别特征：看到什么就该想到它
                 conditions Json,     // 适用条件与失效边界
                 steps Json,          // SolutionStep[]
                 checks Json,         // 结果自检手段
                 proficiency Float, lastUsedAt DateTime }
model MethodEdge { id, fromMethodId, toMethodId,
                 kind enum(SPECIALIZES,COMBINES_WITH,CONTRASTS_WITH) }

// ============ 出题与作答 ============
model Problem  { id, canvasId, type, stemMd, stemMathml,
                 options Json,        // [{ key, text, errorTag }]
                 answer Json,
                 judgeRule enum(EXACT,NUMERIC_TOL,RUBRIC,CHOICE),
                 difficulty Int,      // 0-5 标定
                 bloom enum(REMEMBER,UNDERSTAND,APPLY,ANALYZE,EVALUATE,CREATE),
                 sourceNodeId,
                 status enum(PENDING,VERIFIED,REJECTED),
                 rejectReason }
model ProblemConcept { problemId, conceptId }
model ProblemMethod  { problemId, methodId, role enum(REQUIRED,OPTIONAL,DECOY) }
model Attempt  { id, problemId, userId, answer Json, isCorrect Bool,
                 errorTags Json, timeSpentSec Int, createdAt }
model ErrorTag { id, code, label,
                 category enum(CONCEPT_GAP, METHOD_MISMATCH,
                               CONDITION_MISSED, COMPUTE_SLIP,
                               READING_SLIP, CHECK_OMITTED) }
model Paper    { id, canvasId, title, spec Json, items Problem[] }
```

### `SolutionStep` 结构（固定，不可扩展字段名）

```ts
type SolutionStep = {
  order: number
  goal: string           // 这一步要达成什么
  cue: string            // 触发信号：题目中出现什么时执行这一步
  action: string         // 具体操作（可含公式）
  why: string            // 为什么这一步有效（依据哪个概念/定理）
  conceptIds: string[]   // 必填，至少一个
  falterAt?: string      // 学生最常在此步骤出错的地方
}
```

`cue` 与 `why` 是方法卡的价值所在——只写 `action` 的方案本质上是"解题过程截屏"，对迁移毫无帮助。

### 错因分类（`ErrorTag.category`）

| 分类 | 含义 | 对应补丁 |
| --- | --- | --- |
| `CONCEPT_GAP` | 缺某个概念 | 回到概念卡 + 前置概念链 |
| `METHOD_MISMATCH` | 选错方法 | 方法对比训练 + trigger 判别练习 |
| `CONDITION_MISSED` | 漏看适用条件 | 条件边界陷阱题 |
| `COMPUTE_SLIP` | 计算失误 | 分步计算题 + 自检习惯 |
| `READING_SLIP` | 读题失误 | 题干拆解题 |
| `CHECK_OMITTED` | 未做结果自检 | 检验类问题训练 |

---

## 节点执行器契约

所有节点统一实现以下接口：

```ts
export interface NodeExecutor<P = any> {
  type: string
  inputs: JSONSchema
  outputs: JSONSchema
  run(ctx: {
    params: P
    inputs: Record<string, unknown>
    llm: LLMGateway
    spans: SpanResolver
    user: UserCtx
  }): Promise<{ outputs: Record<string, unknown>; usage: TokenUsage }>
}

export function registerExecutor(e: NodeExecutor): void
```

**实现规则：**

- 执行器位于 `src/nodes/executors/<type>.ts`，通过 `src/nodes/registry.ts` 注册
- 指纹：`sha256(JSON(上游 artifacts) + JSON(params) + modelVersion + promptVersion)`
- 指纹命中则直接返回缓存产物，`tokensIn / tokensOut` 记为 0
- 端口类型不匹配的连线在 **UI 层与服务层双重拒绝**（前端提示 + 后端 400）

---

## 节点清单（共 17 个，分三批实现，不要多做）

### 第一批 · 知识底座（9 个）

| type | 名称 | 说明 |
| --- | --- | --- |
| `source` | 文件解析 | PDF/PPT/网页/录音 → 原文 + span 索引 |
| `chunk` | 语义切片 | 按论点/段落切分，输出 chunk 列表 |
| `extract` | 概念抽取 | 小模型，输出 name / definition / spanIds |
| `card` | 概念卡 | 富文本 + 引用角标，无 span 不入卡 |
| `prereq` | 先修推断 | 输出 `ConceptEdge(PREREQUISITE)`，需人工 Gate 确认 |
| `quiz` | 出题（简易） | 概念自测题，走 `check` 校验后入库 |
| `grade` | 判分 | 对错 + 错因归类，错因必须回连某概念或方法 |
| `review` | FSRS 调度 | 写 `dueAt` / `mastery` |
| `gate` | 人工闸门 | 批量执行前的成本与质量确认 |

### 第二批 · 解题方法建模（4 个）

| type | 名称 | 说明 |
| --- | --- | --- |
| `probe` | 题型与考点识别 | 输入题目/例题，输出题型标签、涉及概念、隐含条件、易漏条件 |
| `method` | 解法抽取 | 典型案例 → `Method`：trigger / conditions / steps / checks / falterAt |
| `solve` | 分步解法演示 | 生成带 `cue` 与 `why` 的解题链，每步绑定 `conceptId`；**不可跳步** |
| `diagnose` | 错因归因 | 输入作答记录，输出 `ErrorTag` 集合 + 定位到具体步骤 + 补丁建议 |

### 第三批 · 出题与组卷（4 个）

| type | 名称 | 说明 |
| --- | --- | --- |
| `variant` | 变式生成 | 沿六个维度生成变式，保留原题的方法结构 |
| `distractor` | 干扰项设计 | 每个错误选项绑定一个 `ErrorTag`，禁止荒谬选项 |
| `check` | 题目质量闸门 | 可解性 / 判分确定性 / 无歧义三检，输出 `status` 与 `rejectReason` |
| `paper` | 组卷 | 按知识点覆盖 + 难度分布 + 方法覆盖约束装配试卷 |

### 变式的六个维度

`variant` 节点的 `params.axes`，可多选：

| 维度 | 说明 |
| --- | --- |
| `NUMERIC` | 改数值与量级 |
| `CONTEXT` | 换情境背景（应用题场景、单位体系、学科表述） |
| `CONDITION` | 增删或收紧条件，考察适用边界 |
| `DIRECTION` | 正向 ↔ 逆向提问 |
| `REPRESENTATION` | 文字 ↔ 公式 ↔ 图表互换 |
| `COMPOSITE` | 与其他方法组合，考察方法编排 |

> **默认要求**：`CONDITION` 维度必须生成至少一道「条件缺失导致方法失效」的陷阱题。这是方法教学中被跳过最多、又最决定水平的一环。

---

## API 契约（必须实现）

### REST

```
# 画布与执行
POST /v1/canvases
POST /v1/canvases/:id/nodes
POST /v1/nodes/:id/run                      → { runId }
GET  /v1/runs/:id/events                    → text/event-stream
GET  /v1/canvases/:id/graph?view=pipeline|knowledge|method

# 知识
GET  /v1/concepts/due
POST /v1/concepts/:id/reviews

# 方法
GET  /v1/methods?conceptId=&proficiencyBelow=
GET  /v1/methods/:id
POST /v1/methods/:id/practice               → 生成该方法专属练习组

# 出题与组卷
POST /v1/problems/generate                  → { problemIds[] } 全部经 check 校验
GET  /v1/problems/:id
POST /v1/problems/:id/attempts              → 判分 + ErrorTag
GET  /v1/problems/due?methodId=
POST /v1/papers/assemble                    → 组卷，body 为 spec

# 分析
GET  /v1/analytics/error-tags?range=30d     → 错因分布

# 兼容层
POST /v1/chat/completions                   → OpenAI 兼容代理（计量 + 路由 + 前缀缓存）
```

### MCP Server

暴露同名工具，供外部 Agent 操作画布：

```
canvas.create   canvas.get     node.create    node.run    graph.query
methods.match(problemId)       methods.get    methods.practice
problems.generate              problems.attempt           papers.assemble
analytics.errors
```

### 鉴权

OAuth2 + Personal Access Token，scope 分：

```
canvas:read | canvas:write | run:execute | problem:read
```

分享工作流时只授予 `canvas:read` + `clone`。

### Webhook

```
node.run.completed
concept.mastery.changed
method.proficiency.changed
review.due
problem.rejected
```

---

## 前端交互要点

### 视图系统

一个画布，右上角视图切换器三档：`pipeline` ⇄ `knowledge` ⇄ `method`。

切换时同一实体的 id 不变，**只换布局算法与边渲染**——是投影，不是三套数据。

### 节点状态

节点卡片右上角三态：`ready` / `stale` / `error`。

> **stale 用琥珀色描边，红色只留给 error。** 上游改动不是错误，用红色会让学生误以为出问题了。

### 溯源

点击任意引用角标 → 右侧抽屉打开原文并高亮 span。

### 三种视图的渲染规则

**知识点视图（knowledge）**
- d3-force 布局
- 节点半径映射 `mastery`
- 颜色映射 `dueAt` 紧迫度

**方法视图（method）**
- 以 `Method` 为主体
- 边渲染 `SPECIALIZES / COMBINES_WITH / CONTRASTS_WITH`
- 节点外环显示 `proficiency`，低于阈值（默认 0.6）的节点带虚线边框

**加工视图（pipeline）**
- 有向 DAG，从左到右
- `stale` 节点及其下游整条链加琥珀色虚线路径

### 方法卡排版（固定五段）

```
① 看到什么用它        trigger
② 什么时候不能用它    conditions
③ 步骤链              每步带 cue / why / falterAt
④ 结果自检            checks
⑤ 关联概念            conceptIds
```

**不做成流水账段落。** 五段式是方法卡能被反复查阅的前提。

### 作答与错题

- 题目作答页：错题展开后显示「你的路径」与「参考路径」的**并排分步对比**，差异步骤高亮
- 差异步骤直接挂载对应 `Method` 与补丁练习入口

### 组卷页

- 给定知识点集合与时长
- 实时显示难度分布直方图与知识点覆盖缺口警告
- 覆盖不足时**必须报缺口**，不允许静默补齐

### 模板市场

支持克隆画布（只读克隆，保留署名）。

---

## 实施顺序（严格按此推进，每阶段产出可运行 demo）

### M1 画布底座
- Prisma schema 全量落地
- 画布 CRUD
- 17 个节点的占位卡片 + 拖拽
- 端口类型校验连线（双端拒绝）

### M2 执行链路
- `registry` + BullMQ
- `source` / `chunk` / `extract` / `card` 四节点跑通
- span 溯源抽屉
- 指纹缓存

### M3 知识视图
- `prereq` 节点
- 图投影
- 掌握度热力
- `review` FSRS 调度
- 今日到期页

### M4 开放能力
- REST + SSE
- MCP server
- PAT 鉴权
- 克隆接口

### M5 解题方法
- `probe` / `method` / `solve` / `diagnose`
- method 视图
- 双熟练度模型
- 错题看板

### M6 出题组卷
- `variant` / `distractor` / `check` / `paper`
- 题库
- 组卷页
- 变式六维参数面板

每完成一个里程碑，写 `docs/milestone-N.md`，记录已验证行为与未完成项。

> **未通过验收的行为不得在文档中写成已完成。**

---

## 验收标准

### 知识链路
- [ ] 上传 60 页 PDF，5 分钟内产出 ≥15 张概念卡，每张至少 1 个可点击 resolve 的 span 引用
- [ ] 修改 `chunk` 参数后，下游 `card` 变 stale 且不消耗 token

### 方法链路
- [ ] 输入一道例题，`method` 节点产出 MethodCard，steps 每步都有非空 `cue` 与 `conceptIds`，且至少标注一个 `falterAt`
- [ ] 同一方法在两个不同情境的题目中各成功应用一次后，`proficiency` 上升
- [ ] 连续两次方法误用后，`proficiency` 下降
- [ ] `diagnose` 对一份错答能输出 ≥1 个 `ErrorTag` 并定位到具体步骤编号

### 出题链路
- [ ] `problems/generate` 返回的每道题 `status = VERIFIED`
- [ ] 人为注入一道无解题，必须被 `check` 判为 `REJECTED` 并附理由
- [ ] 选择题每个错误选项都有非空 `errorTag`
- [ ] 不存在 `|option - answer| / answer > 10` 这类量级荒谬的选项
- [ ] `paper/assemble` 给定 5 个知识点与 60 分钟，产出的试卷难度分布与知识点覆盖度均在 spec 容差内，否则明确报出缺口
- [ ] 同一 Method 生成的变式在六个维度上至少覆盖所选 `axes` 中的全部项

### 工程
- [ ] 全量单测覆盖：指纹计算、DAG 拓扑排序、端口类型校验、FSRS 状态推进、三检闸门判定
- [ ] 外部 Agent 经 MCP 调用 `methods.match` + `problems.generate`，结果可回到画布成为新节点

---

## 输出方式

1. 先输出**目录树**与**完整 schema 文件**
2. 等我确认后再逐个模块实现
3. **不要一次性生成整个仓库**
4. 每批节点先给**执行器接口 + 一个参考实现**，确认风格一致后再铺开其余节点

---

## 附：常见跑偏点自查

在写每一段代码前，确认自己没有滑向以下方向：

| 跑偏 | 正确做法 |
| --- | --- |
| 把 Method 做成概念卡的一个字段 | 独立表、独立熟练度、独立视图 |
| 把 `mastery` 和 `proficiency` 合成一个数 | 两条曲线，两套调度 |
| 出题后直接入库，靠用户举报纠错 | 过 `check` 三检，未过不入库 |
| 干扰项用"随便换个数字"生成 | 每个错项绑定 `ErrorTag`，有诊断价值才能存在 |
| 解题步骤只写 `action` | `cue` + `why` + `falterAt` 必填 |
| 上游改动后自动重跑下游 | 标 stale，等用户点执行 |
| 给 `Edge` 加第四种 kind 来放新关系 | 新建关系表 |
| 生成无 span 的概念卡 | `UNVERIFIED` 拦截 |
| 组卷时悄悄用相似题补足缺口 | 明确报缺口 |
| 写作节点直接生成成段正文 | 骨架 + 证据槽位 + AI 参与度元数据 |
