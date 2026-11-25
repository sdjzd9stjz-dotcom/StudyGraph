# StudyGraph

https://github.com/user-attachments/assets/eb32aac2-2529-4190-a0ff-404f53d9d2c4

面向大学生的**节点式 AI 学习平台**。把课堂材料拖进画布，用节点连线完成
`原料 → 理解 → 结构化 → 解题方法建模 → 训练 → 出题与组卷 → 复习`，
沉淀成一张可溯源、可复习、可导出的个人知识网络。

同时，**底部对话栏是一个能动手改画布的 agent**：用你自己配置的模型，
读得到画布上的全部内容，也能直接建节点、连线、拆卡、整理布局。

平台同等对待两种资产：

- **知识资产** `Concept` —— 概念是什么，携带**记忆掌握度**（FSRS 调度）
- **能力资产** `Method` —— 题目怎么做，携带**方法熟练度**（近期成功率 + 迁移成功率）

两者是两条独立的遗忘曲线，两套独立的状态变量，**永不合并**。
大多数笔记工具止步于"把材料变成卡片"，而学生真正的痛点是"上课听懂了，做题不会"——
`Method` 是解决这个痛点的载体。

---

## 当前状态

**Windows 桌面版，当前本地安装包版本为 0.22.3。** 画布提供 19 种可运行的节点，覆盖课件解析、知识卡制作、练习、组卷和复习。

| 已交付 | 路径 |
| --- | --- |
| 桌面客户端（自带 Node / PostgreSQL 16.9 / pgvector / OCR 语言包） | `apps/desktop/`、`scripts/build-desktop.mjs` |
| 19 个节点执行器（含深入理解、导出讲义） | `apps/api/src/nodes/executors/` |
| 画布 agent（原生 function calling，工具只作用于画布） | `apps/api/src/routes/assistant-agent.ts` |
| LLM 分层：BYOK、模型路由、流式降级、JSON 降级 | `apps/api/src/llm/` |
| PDF / PPTX / 纯图片 PDF（OCR）解析 | `apps/api/src/storage/` |
| 概念拆分、一键整理布局 | `apps/api/src/domain/split-cards.ts`、`layout.ts` |
| Next.js 界面：画布、复习、题库、错题看板、模型配置、**内置教程** | `apps/web/app/` |
| 全量领域模型（46 表 / 33 枚举） | `packages/db/prisma/schema.prisma` |
| 迁移（18 份，含物理约束与触发器） | `packages/db/prisma/migrations/` |
| 使用说明书（Markdown + PDF，应用内 `/guide` 直接读它） | `docs/使用说明书.md` |
| 架构决策与不变量 | `docs/architecture.md` |

安装包：`dist-desktop/installer/StudyGraph-Setup-<版本>.exe`（目标机不需要装任何东西，
不需要 Docker、不需要管理员权限，支持卸载时保留数据并在重装后自动接上）。

---

## 桌面版怎么用

1. 双击安装包（**安装路径必须是纯英文**，PostgreSQL 在中文路径下起不来）
2. 打开后进「模型供应商」，填自己的密钥（DeepSeek / 通义 / Kimi / OpenAI / 自建 OpenAI 兼容端点都行）
3. 新建画布 → 上传 PPTX 或 PDF → 从左侧拖节点、连端口
4. 每个节点点 ▶ 运行；点 💬 就这个节点的内容提问
5. 底部对话框直接说人话：`把课件做成知识卡并出题`、`把概念拆成知识卡`、`帮我整理一下`

### 用知识卡出题和复习

1. 依次运行「文件解析 → 语义切片 → 概念抽取 → 概念卡」。展开画布下方的「概念卡」面板，对照原文检查待复核的概念，内容正确时点「确认」。
2. 把知识卡连到出题节点。要练某类题，可在参数栏选择题型；参数栏留空时，也可以在提示词里写「只出证明题」。运行后只保留符合限定题型的题目，证明题和简答题按要点评分。
3. 把知识卡直接连到复习节点，点 ▶ 为当前画布已确认的概念生成复习计划。复习节点也接受判分结果。

详细操作见应用内「教程」，或打开[在线说明书](docs/使用说明书.md)和 [PDF 版](docs/使用说明书.pdf)。

---

## 开发

```bash
pnpm install --ignore-scripts   # 本机必须带 --ignore-scripts，原因见 docs/runbook.md
cp .env.example .env            # Windows: copy .env.example .env

pnpm db:validate                # 校验 schema
pnpm db:generate                # 生成 Prisma Client
pnpm db:deploy                  # 应用迁移（需要 DATABASE_URL）
```

跑测试：

```bash
# 契约测试（无依赖）
node packages/contracts/test/ports.test.ts

# 出题题型约束（使用模拟模型，在仓库根目录运行）
node --test apps/api/test/unit/quiz-type-constraint.test.ts apps/api/test/unit/quiz-executor-constraint.test.ts

# 集成测试需要真实 PostgreSQL（DATABASE_URL 指向可用的测试库）
pnpm --filter @studygraph/api test:integration
```

打包桌面版：

```bash
node scripts/build-desktop.mjs                            # → dist-desktop/<时间戳>/StudyGraph
ISCC.exe scripts/desktop-installer.iss /DSourceDir=... /DAppVersion=x.y.z
```

注意：`npm install` 会破坏 pnpm 的 hoisted 布局（zod 解析失败、十几个测试变红），
要用 `npx pnpm@11 install` 恢复。

## 目录

```
studygraph/
├─ apps/
│  ├─ api/        Fastify：63 个 REST 接口 + LLM Gateway + 19 个节点执行器 + 画布 agent
│  ├─ web/        Next.js 14 App Router：画布、复习、题库、错题看板、模型配置、教程
│  └─ desktop/    Electron 壳：内置库生命周期、preload、PDF 打印
├─ packages/
│  ├─ contracts/  前后端共享：节点类型、端口矩阵、指纹、连线校验
│  ├─ db/         Prisma schema + 18 份迁移 + 手写 SQL（递归 CTE、物理约束）
│  └─ ui/         设计令牌与共享原语
├─ scripts/       prisma CLI 启动器、打包、审计、验收
├─ vendor/pg16/   打包用的 PostgreSQL 16 + pgvector 运行时
└─ docs/          architecture / runbook / milestone-N / 使用说明书
```

完整清单（含每个文件职责）见 [docs/structure.md](docs/structure.md)。

---

## 19 个节点

| 批次 | 节点 |
| --- | --- |
| 知识底座 | `SOURCE` `CHUNK` `EXTRACT` `CARD` `PREREQ` `QUIZ` `GRADE` `REVIEW` `GATE` |
| 解题方法建模 | `PROBE` `METHOD` `SOLVE` `DIAGNOSE` |
| 出题与组卷 | `VARIANT` `DISTRACTOR` `CHECK` `PAPER` |
| 知识网络 | `DEEPEN`（深入理解：只吃知识卡与题目）、`LECTURE`（导出讲义：可导出 PDF） |

端口类型在 `packages/contracts/src/ports.ts` 统一声明，前端连接时即时提示、
服务端再判一次 —— 双端同源，连不上就是真的连不上。

---

## 五条不可违反的硬约束

1. **溯源是物理约束** —— 任何 AI 生成的事实性论断必须携带 `source_span`；
   无引用的资产只能是 `UNVERIFIED`，不得进入卡片。数据库触发器强制这一点。
2. **执行必须显式触发** —— 上游变更只把下游标 `STALE`，绝不自动重跑；
   连底部 agent 也只能摆放节点，运行必须由用户点 ▶。
3. **写作类节点只给骨架** —— `Outline` / `Draft` 输出结构与证据槽位，不生成成段正文。
4. **出题必须过质量闸门** —— 可解性 / 判分确定性 / 无歧义三检，
   任一失败标 `REJECTED` 并附理由，不得入库。
5. **每个干扰项必须诊断一个错因** —— 错误选项绑定 `ErrorTag`，禁止凑数选项。

另有一条关于 AI 的边界：**底部 agent 提供 9 个画布工具**
（查画布、读产出、建/改/删节点、建/删连线、拆卡、整理），
没有文件、网络、命令，也不能执行节点。

设计理由与实现落点见 [docs/architecture.md](docs/architecture.md)。

## 里程碑

| 里程碑 | 范围 | 状态 |
| --- | --- | --- |
| M1 | 画布底座：schema、画布 CRUD、节点卡片、端口校验连线 | 已完成 |
| M2 | 执行链路：registry、source/chunk/extract/card、溯源抽屉、指纹缓存 | 已完成 |
| M3 | 知识视图：prereq、掌握度热力、FSRS 调度、今日到期 | 已完成 |
| M4 | 开放能力：REST、PAT、克隆 | 已完成 |
| M5 | 解题方法：probe/method/solve/diagnose、双熟练度、错题看板 | 已完成 |
| M6 | 出题组卷：variant/distractor/check/paper、题库、组卷页 | 已完成 |
| M7 | 桌面化：内置数据库、安装包、卸载保留数据 | 已完成 |
| M8 | 知识网络：一概念一卡、连线带对话上下文、深入理解、导出讲义 PDF | 已完成 |
| 后续 | 移动端响应式（只读 / 可操作）、云同步 | 待评估 |

## 技术栈

Next.js 14 App Router · TypeScript · @xyflow/react · Fastify · Prisma 6 ·
PostgreSQL 16 + pgvector · Electron 33 · pdfjs-dist · tesseract.js（本机 OCR）

不直连厂商 API（所有调用经 Gateway 收口）、不上 Neo4j、不用 OT —— 理由见
[docs/architecture.md §5](docs/architecture.md)。

## 贡献者

- [sdjzd9stjz-dotcom](https://github.com/sdjzd9stjz-dotcom)
- [Hgiiii-w](https://github.com/Hgiiii-w)
