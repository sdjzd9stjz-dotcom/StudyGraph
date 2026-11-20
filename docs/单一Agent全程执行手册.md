# StudyGraph · 单一 Agent 全程执行手册

> **用法**：把这份文件整份交给执行 Agent。它自包含，不需要再读别的文档就能开工（但需要读规格与代码）。
> **目标**：从当前状态（M2 未关闭）一路做到 M6 交付。
> **模式**：**单 Agent 全程负责**。没有独立验收方，没有监理转批。质量责任全部内化到你身上。
> **生成日期**：2026-11-19

---

## 0. 先读这一段：你的角色变了

**之前的项目是三方协作**：监理写指令 → 工程 AI 施工 → 独立验收 AI 核查。现在监理和验收都撤了，**你一个人干到底**。

这意味着两件事：

**① 少了三份来回，但多了三条纪律。** 以前是别人逼你交证据，现在你得自己逼自己。**下面的"自证三条"是这份手册最重要的一节（§6），比任何功能要求都重要。**

**② 没有人再替你发现"我以为做完了"。** 这个项目历史上被打回三次，全是因为同一个毛病：**代码写了、测试过了、就宣布功能成立**。三次具体是：

| 打回 | 表面 | 真实原因 |
| --- | --- | --- |
| A 项 | "缓存修好了" | 缓存键没覆盖判定函数的全部输入，校验函数变成恒真函数 |
| 008 指纹 | "指纹加了" | 指纹只用路径，换文件仍命中缓存 |
| 010/011 | "迁移加了" | `Problem` 用的是另一个状态枚举，迁移直接 22P02 |

**共同点：验的是"我加了这段代码"，不是"系统行为变了"。** 你现在要独自避开这个坑。

---

## 1. 项目是什么

**StudyGraph** —— 面向大学生的节点式 AI 学习工作流平台。学生在画布上拖节点，把课件变成可溯源的知识卡、方法卡、题目。

**工作区**：`D:\ai学习辅助工作流搭建`

**规格唯一来源**：`StudyGraph-Agent-Prompt.md`（**只读文件**，改前 `attrib -R`，改完 `attrib +R`）

**核心设计（不用再讨论，照做）**：

- **17 个节点类型**，分三批：知识底座 9 个 / 解题方法 4 个 / 出题组卷 4 个
- **双视图 + 方法视图**：pipeline（画布）/ knowledge（概念图）/ method（方法图）
- **17 个 domain model**（不是 18）
- 技术栈：Next 14 App Router + Fastify + Prisma 6.19.3 + PG16/pgvector + BullMQ/Redis + S3 兼容

**已锁定的技术决策（不许重开）**：
```
双视图+方法视图 ｜ Method 独立建表 ｜ 双熟练度分离（mastery ≠ proficiency）
PG 不用 Neo4j ｜ 自建 LLM Gateway ｜ CRDT(Yjs) 不选 OT ｜ stale 琥珀色
显式触发（不自动重跑下游）｜ 三检闸门 ｜ 干扰项绑 ErrorTag ｜ Edge 只有三种 kind
```

---

## 2. 五条硬约束（违反即返工）

| # | 约束 | 具体含义 |
| --- | --- | --- |
| 1 | **溯源是物理约束** | 没有 span 引用的资产不得标记 `VERIFIED`。数据库有触发器拦，不要试图绕过 |
| 2 | **执行必须显式触发** | 上游改了只标 stale，**绝不自动重跑下游** |
| 3 | **写作类节点只给骨架** | 不许直接生成成段正文，必须留证据槽位与 AI 参与度元数据 |
| 4 | **出题必须过三检** | 未过 `check` 的题不入库 |
| 5 | **每个干扰项必须诊断一个错因** | 绑 `ErrorTag`，没诊断价值的干扰项不许存在 |

---

## 3. 当前状态（截至 2026-11-19，commit `4f493b4`）

### 3.1 环境

| 项 | 状态 |
| --- | --- |
| Node 26.13.1 / git 2.56.1 / Docker Desktop 29.9.3 | 已装 |
| postgres / redis / s3(SeaweedFS) | 曾实测 healthy；**Docker 引擎当前不可达，先修这个** |
| DeepSeek key | **401**，需要用户重新生成 |
| pnpm | 本轮交付后应已可用（原机上不在 PATH） |

### 3.2 已完成

**M1 画布底座 —— 已关闭**
```
schema 34 表 / 27 枚举 / 65 索引 / 53 外键
6 个 migration 已应用
CHECK 8 / 触发器 6 / 视图 4
画布 CRUD + 17 个占位卡片 + 端口双端校验
```

**M2 执行链路 —— 主体跑通，未关闭**
```
10 份 PPTX → 40 次执行全部 SUCCEEDED
Source → CHUNK → EXTRACT → CARD 全链路
Source 10 个 / 266 页 / 220 span
27 条候选 claim → 7 张 VERIFIED
扫描件负例 422 SOURCE_HAS_NO_TEXT_LAYER
前缀缓存 D1/D2 通过
```

### 3.3 三层校验方案（已裁决，已施工）

原来要求「定义与引文逐字节相等」，22 字/页 的 PPT 必然产出不了，所以 27 条只过 7 条。已改成三档：

| 档 | 条件 | 结果 |
| --- | --- | --- |
| **T1** | 引文逐字在原文 + 定义=引文 + 名称在定义 + residual 含谓词 | `VERIFIED` |
| **T2** | 引文逐字在原文 + 名称在定义 + residual 含谓词 + bigram Jaccard ≥ 阈值 | `PENDING_REVIEW` |
| **T3** | 其余（含引文造假、纯标题） | `UNVERIFIED`，不产卡 |

**两条铁律：**
- **A1（引文在不在原文）一秒都不能松。** 引文编造一律 T3，T2 的引文也必须逐字可查
- **`PENDING_REVIEW` 不是免检通道。** 宁可 10 张真卡，不要 15 张假卡

### 3.4 M2 未完成项（**你的第一批任务**）

| # | 项 | 状态 |
| --- | --- | --- |
| 1 | Docker 引擎 + DeepSeek key | **环境阻塞，需先解决** |
| 2 | 迁移两路径验证（空库 + 老库） | 代码已改，未验 |
| 3 | 写库实验 a/b/c/d + 两条降级 + 视图 0 行 | 未做 |
| 4 | 纯标题「指数函数练习目录」全链路 | 单测过，全链路未做 |
| 5 | 巡检 A–F 落库实测 | 判定函数过，落库未做 |
| 6 | 复核接口四条 curl | 未做 |
| 7 | 包级 tsc（`apps/api/tsconfig.json`） | 012 已补，未复跑 |
| 8 | **产物完整性快照**（quote / spanText / classifierVersion） | 012 要求，需确认 |
| 9 | **27 条校准表**（含人工判读列）+ 双负例 | 未做 |
| 10 | 真实三态落库数（VERIFIED / PENDING_REVIEW / UNVERIFIED） | 未做 |
| 11 | 新画布重跑（旧画布 `cmwnn9tpg0001q52wfgghlljt` 冻结） | 未做 |
| 12 | 前端溯源抽屉 | 未做 |
| 13 | BullMQ 队列接入（当前同步执行） | 可延后 |

**已知的三个坑（代码里已修，但你要知道为什么）：**

1. **共享触发函数不能硬编码枚举值** —— `Problem` 用 `ProblemStatus`（PENDING/VERIFIED/REJECTED），**没有 `PENDING_REVIEW`**。挂触发器时按实体传状态集；Problem 删光引用降级目标是 `PENDING` 不是 `UNVERIFIED`
2. **谓词判定要在"减去名称后的 residual"上做**，且 residual ≥ 6 字。否则「指数函数练习目录」里的「指」会被当成谓词
3. **巡检按 `reviewedBy` 分三支** —— 自动核实的必须仍是完整 T1；人工 ACCEPT 的只查引文；待审的只查引文

---

## 4. 环境搭建（六步）

### 第 1 步 · 依赖

```bash
corepack enable
pnpm install
# 若 postinstall 报 EPERM：pnpm install --ignore-scripts
```

### 第 2 步 · 容器

```bash
docker compose up -d
docker compose ps      # 三个都要 healthy
```

| 容器 | 镜像 | 端口 |
| --- | --- | --- |
| studygraph-postgres | pgvector/pgvector:pg16 | 5432 |
| studygraph-redis | redis:7-alpine | 6379 |
| studygraph-s3 | chrislusf/seaweedfs | 9000 / 9333 |

> 不是 MinIO —— `minio/minio` 已下架，quay 认证恒 401。SeaweedFS 走同一套 S3 协议，`ObjectStore` 只依赖协议。

### 第 3 步 · 环境变量

```bash
cp .env.example .env
```

必须自己生成的三项：

```bash
# AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# BYOK_ENCRYPTION_KEY —— 用户 API key 的加密主密钥，丢了所有凭据作废
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# LLM key 至少填一个，否则节点报 NO_MODEL_CONFIGURED
```

### 第 4 步 · 建库

```bash
node scripts/prisma.mjs migrate deploy --schema packages/db/prisma/schema.prisma
```

### 第 5 步 · 起服务

```bash
node apps/api/src/server.ts                  # :3001
cd apps/web && node ../../node_modules/next/dist/bin/next build
node ../../node_modules/next/dist/bin/next start -p 3000   # :3000
```

### 第 6 步 · 自检

```bash
node scripts/env-check.mjs
node packages/contracts/test/ports.test.ts     # 27 pass
node apps/api/test/unit/dag.test.ts
node scripts/registry-self-check.mjs
node scripts/s3-roundtrip.mjs
node scripts/verify-011.mjs                    # SKIP ≠ PASS
```

**注意**：`migrate dev` 会生成 `DROP INDEX "Concept_embedding_hnsw"` 和 `DROP INDEX "Concept_name_trgm"`，**必须手工删掉这两行**。日常用 `migrate deploy`。

---

## 5. 剩下的工作（按里程碑）

### M2 收尾（先做这个，别跳过）

按 §3.4 的 13 项逐项打勾。**完成标准不是"代码改了"，是"有输出证明行为变了"。**

特别提醒两个容易糊弄的地方：

- **校准表 27 行，最后一列必须是人工判读。** 机器判 T2，得有人看一眼说"对"或"不对"。这一列全空，表就没写
- **双负例必须有**：① 引文真实但引错页 → A1 失败 ② 引文在本页但定义讲别的 → `BELOW_SIMILARITY`。只贴正例证明不了阈值有用

### M2.5 · BYOK 多供应商通道（规格已写，见 `StudyGraph-Agent-Prompt.md` §「多供应商与 BYOK」）

**性质变更备案**：原来是系统单一密钥接 2-3 家，现在是**每个学生带自己的 key**，预置 10+ 厂商，成本学生自负。**「自建 Gateway」不变**。

4 张新表：`Provider` / `ProviderModel` / `UserCredential` / `UserModelPref`。

四条监理级别的要求（我自己复盘时认为最容易做垮的）：

1. **凭据只进不出** —— AES-256-GCM 加密，任何响应只给 `last4`。要专门验证"响应体里有没有明文"，不能只看"我加了加密函数"
2. **429 ≠ INVALID** —— key 是对的，只是限流。**超时/网络错误要保留原状态**。一次网络抖动能把好 key 判死
3. **路由解析结果必须进指纹** —— `credentialId` / `modelId` / `baseUrl` 都算。否则"换了 key 还命中旧缓存"，就是 A 项错误的第四次重演
4. **能力不匹配拦在保存时** —— 学生用不支持 JSON 的模型跑 `extract`，整条链路产物作废且他不知道为什么

### M3 · 知识视图

```
prereq 节点 / 图投影 / 掌握度热力 / review FSRS 调度 / 今日到期页
```

### M4 · 开放能力

```
REST + SSE / MCP server / PAT 鉴权 / 克隆接口
```

### M5 · 解题方法

```
probe / method / solve / diagnose 四节点
method 视图 / 双熟练度模型 / 错题看板
```

### M6 · 出题组卷

```
variant / distractor / check / paper 四节点
题库 / 组卷页 / 变式六维参数面板
```

### ⚠️ UI 阶段（M3 起，每个里程碑都有）

**你之前被告知过：UI 部分建议换一个专门的 AI 做。**

现在改成单 Agent 全程，这条要不要执行由用户决定。**你在开工 M3 之前，必须主动问用户一次：**

> "M3 开始要出界面了。是继续由我做，还是这一部分交给专门的 UI AI？如果交出去，我会先整理交接清单（规格、锁定决策、现有路由与组件、`packages/contracts` 类型）。"

**不要默默自己做完。** 这是用户明确提过的偏好，即使现在改了口径，也要确认一次。

---

## 6. 自证三条（替代验收方）

没有独立验收，所以**你自己就是验收**。这三条是这份手册的核心。

### 自证 1 · 每条"已完成"要能回答：删掉这条断言，什么 bug 会漏

写完任何一条测试或验证，问自己这句话。答不出来 = 这条断言没有价值。

**反例**（这个项目真实发生过）：
```
验证：迁移执行成功 → ✅
漏掉：Problem 表也挂了同一个触发器，而它没有 PENDING_REVIEW 枚举
```

### 自证 2 · 证据必须是可粘贴的终端原文

不行：截图、"测试全过"、`console.log('ok')`、自己写的断言里硬编码 `true`。

可以：真实命令 + 原始输出 + 触发它的输入。

**每个"通过"都要能指出：哪条命令、什么输入、什么输出。**

### 自证 3 · 判据的输入必须全部可追溯

这是本项目三次 P0 的共同根因（A 项缓存 / 008 指纹 / 产物丢 quote）。检查方式：

```
判定函数 f(x, y, z)  → 缓存键里有没有 x, y, z 全部？
                     → 产物里有没有存 x, y, z 全部？
```

**只存结果、不存依据 = 永远证明不了它对。**

---

## 7. 红线与高频陷阱

| 陷阱 | 怎么识别 |
| --- | --- |
| **用身份代替内容做判定** | 缓存用 id/路径/区间，而不是文本内容。**本项目已踩三次** |
| **只问"有没有"不问"是不是人话"** | 劣质 OCR 的乱码能通过 span 校验 |
| **静默截断** | `chunk` 吞字符、CTE `depth < 64`、视图返回空数组 |
| **护栏自身静默降级** | `check-drift.mjs` 连不上库却报"无漂移" |
| **缓存把校验函数变成恒真函数** | 判定函数的输入没全部进缓存键 |
| **判据被悄悄弱化** | 巡检从"完整 T1"变成"只看 A1"，测试全绿 |
| **把结果当依据** | 存了 verdict 不存 quote |
| **前端拦、后端不拦** | curl 绕开 UI 直测 |
| **跑偏自查表** | 规格文件末尾有一张表，开工前读一遍 |

**另外几条项目特有的：**

- **不许用 PGlite 冒充真实 PG 的验收证据**。PGlite 能证明 SQL 语义，不能证明容器行为
- **不许降 `strict` 换 tsc 绿灯**
- **不许用 `as any` / `as never` 压类型错误**
- **不许在新旧批次混数据凑数量**

---

## 8. 工作节奏建议

**每个里程碑做完，写 `docs/milestone-N.md`**，必须包含：

```markdown
## 已完成（附验证命令与输出）
## 未完成 / 已知缺陷
## 与规格的偏离（如有，必须标明原因）
```

**规矩：未通过验证的行为不得在文档中写成已完成。**

建议的工作循环：

```
1. 从 §3.4 或里程碑清单取一项
2. 先写"怎么证明它成立"（命令、输入、期望输出）
3. 再写代码
4. 跑验证，输出贴进 milestone 文档
5. 通过就勾掉，不通过就回第 3 步
```

**先写验证再写实现**，这一条能挡掉上面所有陷阱。

---

## 9. 交接清单（原机器这边要单独给的）

这些**不跟仓库走**：

| 项 | 为什么 |
| --- | --- |
| `课件/` （10 份 PPTX + 2 份 PDF） | gitignore，体积大 |
| `.env` 或其中的密钥值 | gitignore |
| **`BYOK_ENCRYPTION_KEY`** | 丢了用户凭据全废，必须单独安全传递 |
| `apps/web/.env.local` | gitignore |

---

## 10. 一句话

> 这个项目被打回三次，没有一次是因为"不会写"，全都是因为**"验证的不是系统行为"**。你现在没有验收方兜底了 —— **把 §6 那三条当成开工前的检查表，而不是完成后的补充说明。**

---

*配套：`StudyGraph-Agent-Prompt.md`（规格）· `docs/runbook.md`（本机坑）· `docs/环境安装与接续提示词.md`（换机器）*
