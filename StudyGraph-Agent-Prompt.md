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
| 模型 | 自建统一 LLM Gateway 抽象层，**预置 10+ 供应商目录 + 学生自带凭据（BYOK）**，支持前缀缓存。详见「多供应商与 BYOK」一节 |

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

## 多供应商与 BYOK（学生自带模型凭据）

**核心体验：学生填入自己的 key、选个模型就能用。预置常见厂商端点，无需知道 baseUrl；也可自定义 OpenAI 兼容端点。对标 Cherry Studio 的供应商管理体验。**

### 为什么必须做

1. 学生付不起平台统一供模型的成本，但每个人手上有不同的额度
2. 校园网关、企业代理、本地 Ollama 各有各的端点，写死两三家覆盖不了
3. 但**前端绝不许直连厂商 API** —— 凭据要加密落库、用量要计量、前缀缓存要生效，这些只能在服务端做

> 「自建 Gateway」这条不变。变的是凭据来源：从一个系统密钥，变成每个用户自己的密钥。

### 数据模型（4 张新表）

```prisma
/// 系统预置厂商目录（运维维护，学生只读）
model Provider {
  id          String   @id @default(cuid())
  slug        String   @unique            // openai | deepseek | anthropic | moonshot | ...
  name        String
  protocol    ProviderProtocol            // OPENAI | ANTHROPIC | GEMINI
  baseUrl     String
  docsUrl     String?                     // 「去哪里拿 key」
  byokEnabled Boolean  @default(true)
  sortOrder   Int      @default(0)
  models      ProviderModel[]
}

model ProviderModel {
  id            String  @id @default(cuid())
  providerId    String
  modelId       String                    // 请求时用的 model 名
  displayName   String
  contextWindow Int
  maxOutput     Int?
  /// { jsonObject: boolean, vision: boolean, reasoning: boolean, toolUse: boolean }
  capabilities  Json
  /// 每百万 token，用于估算花费；厂商不给价就留空，不要瞎填
  inputPrice    Decimal? @db.Decimal(12, 6)
  outputPrice   Decimal? @db.Decimal(12, 6)
  enabled       Boolean @default(true)
  @@unique([providerId, modelId])
}

/// 用户自己的凭据。**只进不出**
model UserCredential {
  id              String  @id @default(cuid())
  userId          String
  providerId      String
  label           String?                 // 用户自起名："我的 DeepSeek"
  ciphertext      Bytes                   // AES-256-GCM
  iv              Bytes
  authTag         Bytes
  keyVersion      Int                     // 支持主密钥轮换时双版本并存
  last4           String                  // 仅用于展示：sk-…a1b2
  status          CredentialStatus        // UNVERIFIED | VALID | INVALID | RATE_LIMITED
  lastCheckedAt   DateTime?
  lastError       String?
  /// 自定义 OpenAI 兼容端点用；为空则用 Provider.baseUrl
  baseUrlOverride String?
  createdAt       DateTime @default(now())
  @@unique([userId, providerId, label])
  @@index([userId])
}

/// 按任务类型的模型偏好（可选，不配则走默认）
model UserModelPref {
  id           String @id @default(cuid())
  userId       String
  taskType     String                     // chunk | extract | judge | quiz | check | variant | probe | method | solve
  credentialId String
  modelId      String
  @@unique([userId, taskType])
}
```

### 凭据安全（红线，不可协商）

| 要求 | 具体 |
| --- | --- |
| 加密存储 | AES-256-GCM，主密钥来自进程环境变量 `STUDYGRAPH_SECRET_KEY`，**绝不进仓库、不进 .env 文件** |
| **只进不出** | 任何 API 响应只返回 `last4` 掩码。**明文 key 一次都不许出现在响应体里** |
| 不回显 | 编辑页展示 `sk-…a1b2`，用户要换就重填整串，**不做"显示原文"** |
| 不进日志 | 不进日志、错误信息、`Run.errorMessage`、`details`、`NEXT_PUBLIC_*`、URL query |
| 跨用户隔离 | 读取凭据的每条查询都必须带 `userId` 条件；**管理员也不能读明文** |
| 导出剔除 | 备份 / 导出功能里 key 必须被剔除 |

### 预置厂商目录（首期至少这些）

| 厂商 | protocol | baseUrl |
| --- | --- | --- |
| OpenAI | OPENAI | `https://api.openai.com/v1` |
| Anthropic | ANTHROPIC | `https://api.anthropic.com` |
| Google Gemini | GEMINI | 原生协议 |
| DeepSeek | OPENAI | `https://api.deepseek.com` |
| Moonshot / Kimi | OPENAI | `https://api.moonshot.cn/v1` |
| 智谱 GLM | OPENAI | `https://open.bigmodel.cn/api/paas/v4` |
| 阿里通义 DashScope | OPENAI | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 硅基流动 SiliconFlow | OPENAI | `https://api.siliconflow.cn/v1` |
| OpenRouter | OPENAI | `https://openrouter.ai/api/v1` |
| Ollama（本地） | OPENAI | `http://localhost:11434/v1`，key 可空 |
| **自定义 OpenAI 兼容** | OPENAI | 用户自填 `baseUrlOverride` |

**约束：**

- 预置项**只填 key 就能用**，不要求用户知道 baseUrl
- 每项都要有「获取 key」的文档链接
- **OpenAI 兼容的厂商共用一个适配器，靠 `protocol` 分派**。不许复制粘贴多份适配器只改域名——那样修一个 bug 不会同步到其他家

### 三个产品问题，必须先想清楚

**① 用户不配 key 怎么办**

```
有系统 key   → 回落系统 key，界面明确标注「使用平台额度」
无系统 key   → 报 NO_MODEL_CONFIGURED，中文提示引导去配置
```

**绝不允许**在无可用模型时静默跑一个假结果。

**② 用户选了能力不够的模型**

学生可能为了省钱选一个不支持 JSON 输出的模型跑 `extract`，结果整条链路产物作废，而他不知道为什么。

- 每个 `taskType` 声明所需能力（如 `extract` 需要 `jsonObject: true`）
- 选中不满足能力的模型时，**保存即拒绝**，并说明缺哪项能力
- 厂商未声明能力时允许选择，但打 `UNTESTED` 标记；首次失败时给出针对性提示

**③ 成本算谁的**

`UsageRecord` 必须能回答「这笔 token 是谁的钱」：

```
credentialId 为空 → 平台承担
credentialId 非空 → 该用户承担
```

按用户展示自己的月度用量与估算花费。**用户的 key 用量不许算进平台账。**

### 测试连接：不能拿「保存成功」冒充「能用」

- 保存时**不做自动探活**（拖慢且易误判）
- 提供显式的「测试连接」：一次最小请求，超时 10s
- **判定要分类，不能一锅烩：**

| 结果 | 状态 |
| --- | --- |
| 200 + 合法响应 | `VALID` |
| 401 / 403 | `INVALID` |
| 429 | `RATE_LIMITED` —— **不是 INVALID**，key 是对的 |
| 超时 / 网络错误 | **保持原状态**，只记 `lastError` |

> 最后一行最容易做错。**不能因为一次网络抖动，把一把好 key 判死。**

### 路由解析顺序

```ts
resolveModel(taskType, userId) → { credentialId | null, provider, model, baseUrl, apiKey }
```

```
1. UserModelPref[taskType] 有配置        → 用用户的
2. 无配置，但用户有该任务的默认凭证      → 用用户的
3. 用户无凭证                            → 回落系统 key
4. 都没有                                → NO_MODEL_CONFIGURED
```

**解析结果必须进指纹参数**（`credentialId` + `modelId` + `baseUrl` 都算）。

> 否则「换了 key / 换了模型，却命中旧缓存」——这就是把缓存变成恒真函数的老毛病。

### OpenAI 兼容代理

`POST /v1/chat/completions` 必须走同一套路由与计量：

- 请求里可以指定 `model`，但**不能指定 baseUrl 或 key**（那等于让调用方绕过凭据体系）
- 计量写入 `UsageRecord`，归属按上文的 `credentialId` 规则


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

# 供应商与凭据（BYOK）
GET  /v1/providers                          → 预置目录（含 models、docsUrl，不含任何用密钥）
GET  /v1/credentials                        → 只返回 last4 掩码与状态
POST /v1/credentials                        → { providerId, apiKey, label?, baseUrlOverride? }
PATCH  /v1/credentials/:id                  → 换 key / 改名 / 改 baseUrl
DELETE /v1/credentials/:id
POST /v1/credentials/:id/test               → 显式探活，返回 VALID|INVALID|RATE_LIMITED
GET  /v1/model-prefs                        → 各 taskType 当前用哪个模型
PUT  /v1/model-prefs/:taskType              → { credentialId, modelId }

# 兼容层
POST /v1/chat/completions                   → OpenAI 兼容代理（计量 + 路由 + 前缀缓存）
GET  /v1/models                             → 当前路由表实际可用的模型
POST /v1/embeddings                         → 向量化（同一解析链与归属规则）
POST /v1/messages                           → Anthropic 兼容（含 stream）

# Skill（F2）
GET    /v1/skills                           → 内置 + 自己的；不含他人 USER skill
POST   /v1/skills                           → 新建（scope=USER）
PATCH  /v1/skills/:id                       → 改正文 / 开关（改 version）
DELETE /v1/skills/:id
PUT    /v1/nodes/:id/skills                 → { skillIds: [] } 绑定到节点（进指纹）

# 草案（G1）
POST /v1/canvases/:id/drafts                → { request } → 返回草案，不落画布
POST /v1/drafts/:id/accept                  → 落画布（节点 DRAFT/READY，不执行）
POST /v1/drafts/:id/discard
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

## 新能力（2026-11-20 用户拍板：F2 / G1 / H1）

> 范围定义与取舍理由见 `docs/需求-新能力范围定义.md`。本节只写**已拍板的约束**，未选中项不在范围内。

### F2 · Skill 指令包

**定位**：一段可加载的说明（可选附带脚本），在节点执行时作为**额外上下文**注入，用来扩展模型在某类任务上的做法。不是学习模块，不是前端插件。

```prisma
model Skill {
  id           String   @id @default(cuid())
  slug         String   @unique            // chinese-math-notation | citation-strict | ...
  name         String
  description  String                      // 何时该用它（用于选择）
  instructions String                      // 注入 system 的正文
  /// 可选的辅助材料（示例、检查清单），按需拼接，不参与指纹之外的隐式行为
  assets       Json?                       // [{ name, kind, content }]
  scope        SkillScope                  // BUILTIN | USER
  ownerId      String?                     // scope=USER 时必填
  enabled      Boolean  @default(true)
  version      Int      @default(1)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}

model NodeSkill {
  nodeId  String
  skillId String
  @@id([nodeId, skillId])
}
```

**四条约束（与既有硬约束同级）：**

1. **skill 必须显式绑定到节点**（`NodeSkill`），不做“全局自动加载”。绑了哪些、各自 `version` 多少，**全部进指纹**——否则「加了 skill 却命中旧缓存」就是 A 项错误的翻版
2. **skill 正文只能追加到 system 前缀，不得改写用户输入**；含指令冲突时以硬约束为准（例如 skill 要求“无引文也可 VERIFIED”，一律无效）
3. **`scope=USER` 的 skill 读取必须带 `ownerId` 条件**，与他人隔离；`BUILTIN` 由运维维护
4. **skill 不得包含凭据**；加载路径与 BYOK 的 `ciphertext` 完全无关

**注入顺序**（固定，写进指纹）：`硬约束摘要 → skill（按 slug 排序）→ 节点 prompt`

### G1 · 对话式编排（草案，不自动执行）

学生用一句话描述需求，系统生成**节点图草案**。草案与真实画布严格分离。

```prisma
model GraphDraft {
  id        String   @id @default(cuid())
  canvasId  String
  ownerId   String
  request   String                          // 学生的原话
  proposal  Json                            // { nodes: [...], edges: [...] }
  status    DraftStatus                     // PROPOSED | ACCEPTED | DISCARDED
  createdAt DateTime @default(now())
}
```

**三条约束：**

1. **草案不落画布、不执行、不消耗任务 token**（生成草案本身的那一次模型调用除外，且必须计入 `UsageRecord`）
2. **必须由学生显式确认才落画布**，落地后节点状态是 `DRAFT`/`READY`，仍需逐节点显式执行——**绝不因为“草案被确认”就自动开跑**（硬约束 2）
3. 草案里的每个节点必须给出**端口类型与上游依赖**，落画布时走与手工创建相同的校验，不做特权通道

> 明确不做：agent 连续自动执行多步（TapNow 式的“一路做到底”）。这与硬约束 2 直接冲突。

### H1 · 兼容网关

让第三方客户端（ChatGPT 兼容 / Claude 兼容）能把本服务当作模型端点使用，并复用同一套路由、计量与前缀缓存。

| 端点 | 要求 |
| --- | --- |
| `GET /v1/models` | 返回**当前路由表实际可用**的模型；不含未启用的、不含任何凭据信息 |
| `POST /v1/chat/completions` | 已规划；本轮补 **SSE 流式**（`stream: true`） |
| `POST /v1/embeddings` | 走同一解析链；`credentialId` 归属规则不变 |
| `POST /v1/messages` | **Anthropic 兼容**（含 `content` 数组与 `stream`），映射到同一 Gateway |

**四条约束：**

1. **调用方不得指定 `baseUrl` 或 `apiKey`**——只能选模型名，凭据由服务端解析
2. 计量写入 `UsageRecord`，归属按 `credentialId`：为空即平台承担，非空即该用户承担
3. 兼容层**不得绕过**任何硬约束：不带 span 的概念卡仍然不能 `VERIFIED`
4. 鉴权用 PAT（`run:execute` scope），与画布 API 同一套

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
- **BYOK 后端**：Provider 目录、凭据加密存储、按 taskType 路由、用量归属（界面留给 UI 阶段）

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

### M4.5 新能力（F2 / G1 / H1，2026-11-20 拍板）
- **F2** `Skill` / `NodeSkill` 两表 + 绑定进指纹 + 注入顺序
- **G1** `GraphDraft` 草案：生成不落画布，确认后仍需逐节点执行
- **H1** `/v1/models`、`/v1/embeddings`、`/v1/messages`、`chat/completions` 流式

> 顺序上排在 M4 之后：兼容网关依赖 PAT 与路由表，草案落画布依赖画布 CRUD。**M2 未关门之前不开工。**

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
| 把用户的 API key 明文存库或返回给前端 | AES-256-GCM 加密，响应只给 `last4` |
| 任何网络异常都判 key 失效 | 超时保持原状态，只有 401/403 判 INVALID |
| 给节点绑了 skill 却没进指纹 | `skillId + version` 必须进指纹，否则命中旧缓存 |
| 草案被确认后自动开跑下游 | 确认只落画布；执行仍要逐节点显式触发 |
| agent 自己连跑多步（TapNow 式） | 只出草案，等人点执行 |
| 兼容层放宽硬约束（如无 span 也给 VERIFIED） | 兼容层只是入口，判据一处不放 |
| skill 里塞凭据或全局自动加载 | skill 只追加 system；绑定必须逐节点显式 |
