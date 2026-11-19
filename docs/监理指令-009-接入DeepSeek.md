# 监理指令 009 · 接入 DeepSeek 作为实调供应商

> **文号**：SG-SUP-009
> **日期**：2026-11-19
> **依据**：**用户指定**用 DeepSeek API 做样本，并提供了临时 key
> **性质**：解除 SG-SUP-008 §5 的模型阻塞；同时新增一项规格偏离备案与一批 DeepSeek 专属验收项
> **不在本指令范围**：SG-SUP-008 的 P0（源文件指纹）、P1（文字层闸门）、P1（chunk 截断）**仍然有效，照做**

---

## 0. 密钥处理（先读这一节，再碰代码）

### 0.1 三条硬规则

**这条 key 是临时样本，且已经在对话里明文出现过。按"半暴露"对待。**

| 规则 | 具体要求 |
| --- | --- |
| **不落仓库** | 不许写进 `.env`、`.env.local`、任何源码、任何测试文件、任何文档、任何 fixture |
| **不落日志** | adapter 里不许 `console.log(key)`、不许进 error message、不许进 `details`、不许进 `Run.errorMessage` |
| **不进前端** | 不许出现在 `NEXT_PUBLIC_*`、不许进浏览器请求 |

**唯一正确的用法：进程环境变量 `DEEPSEEK_API_KEY`，由用户在启动命令里注入。**

```bash
# 用户自己在终端里执行，执行方不要代劳、不要把 key 写进脚本
DEEPSEEK_API_KEY=<用户提供> node apps/api/src/server.ts
```

Windows PowerShell：

```powershell
$env:DEEPSEEK_API_KEY = '<用户提供>'
node apps/api/src/server.ts
```

### 0.2 密钥卫生检查（必须做，且要出证据）

1. `git check-ignore -v .env` → 必须输出匹配规则
2. 全仓库扫描，确认没有任何文件含 `sk-` 开头的 48 位串：

```bash
rg -n 'sk-[a-zA-Z0-9]{32,}' -g '!node_modules' -g '!.git' .
# 期望：无输出
```

3. `git log -p --all -S 'sk-' --oneline` → 期望无历史命中
4. 启动后打一次 `.env` 与进程环境，确认 key **只存在于进程环境**：

```bash
rg -n 'DEEPSEEK' .env .env.example
# .env.example 里只允许有 DEEPSEEK_API_KEY="" 这样的空占位，不允许有值
```

### 0.3 用完请用户轮换

**这一条写进回报给用户的建议里：** 这份 key 在对话中出现过，M2 验收结束后应到 DeepSeek 控制台作废并重新生成。监理会在 M2 关闭时提醒一次。

---

## 1. 规格偏离备案：供应商从 2 个变 3 个

规格 §技术栈 写的是「自建统一 LLM Gateway 抽象层，**首期接 2 个供应商**」。现在接第 3 个。

**用户已授权（指定用 DeepSeek 做实调样本），记为已批准的偏离。** 要求：

- 写进 `docs/architecture.md` 的 Gateway 一节：「首期规划 2 家（OpenAI / Anthropic），因验收需要临时接入第 3 家 DeepSeek 作为实调供应商；DeepSeek 走 OpenAI 兼容协议，适配成本低于另两家」
- **不要**把 `LLM_DEFAULT_PROVIDER` 直接改成 deepseek 就完事——路由表要显式表达三家各自承担什么

---

## 2. DeepSeek 适配器要求

### 2.1 协议与地址

DeepSeek 兼容 OpenAI Chat Completions 协议。

| 项 | 值 |
| --- | --- |
| Base URL | `https://api.deepseek.com`（或 `https://api.deepseek.com/v1`，以官方文档为准） |
| 认证 | `Authorization: Bearer <key>` |
| 模型 | `deepseek-chat`（通用对话/推理）、`deepseek-reasoner`（深度推理） |
| 结构化输出 | 支持 `response_format: { type: "json_object" }`，需在 prompt 中明确要求输出 JSON |

**实现方式二选一，写明理由：**

- **A（推荐）**：复用 `providers/openai.ts`，把 base URL 与模型名参数化，DeepSeek 作为一个配置项注册进去
- **B**：新建 `providers/deepseek.ts`，内部复用 openai 的请求构造逻辑

**不要复制粘贴一份 openai.ts 再把域名改掉。** 那样以后修 OpenAI 的 bug 不会同步到 DeepSeek。

### 2.2 必须继承的三条既有约束

DeepSeek 适配器**不是新规则，是同一套规则的新实现**。以下三条在 005/006 已定，现在适用：

1. **`usage` 与 `model` 缺失必须报错**（SG-SUP-005 §2.D）
   - DeepSeek 响应里的 `usage` 字段：`prompt_tokens` / `completion_tokens` / `total_tokens` / `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
   - 如果某个字段缺失，**按"字段不存在 ≠ 值为 0"处理**，抛 `PROVIDER_RESPONSE_INVALID`
2. **`modelVersion` 只能取自响应体的 `model` 字段**，不许回退到请求时写的别名
3. **失败必须抛错**，不许返回空对象

### 2.3 路由表

现有 `routing.ts` 要扩成三家。规格要求：机械任务走小模型，推理任务走前沿模型。

**建议映射（可调整，但要在文档里写清理由）：**

| taskType | DeepSeek 侧 | 理由 |
| --- | --- | --- |
| `chunk` | `deepseek-chat` | 切片是机械任务 |
| `extract` | `deepseek-chat` | 概念抽取，需要稳定 JSON 输出 |
| `judge` | `deepseek-chat` | 判分，规则性强 |
| `quiz` | `deepseek-chat` | 出题草稿 |
| `check` | `deepseek-chat` | 三检，要严格按规则判 |
| `variant` | `deepseek-reasoner` | 变式生成需要构造能力 |
| `probe` | `deepseek-reasoner` | 题型识别需要推理 |
| `method` | `deepseek-reasoner` | 解法抽取是 M5 的核心难点 |
| `solve` | `deepseek-reasoner` | 分步解法不可跳步 |

**M2 只用到 `chunk` 与 `extract`，其余是预留。** 表要完整，但不要求全部实调。

---

## 3. 前缀缓存：DeepSeek 的机制与前两家都不同

这一节替换 SG-SUP-006 §3.3 中"两家"的表述，现在是三家。

### 3.1 三家机制对照

| 厂商 | 缓存机制 | 是否可传显式键 | 可观测字段 |
| --- | --- | --- | --- |
| OpenAI | `prompt_cache_key` + 内容前缀 | ✅ 可以 | `usage.prompt_tokens_details.cached_tokens` |
| Anthropic | 内容寻址 + `cache_control` 标记块 | ❌ 不能 | `usage.cache_read_input_tokens` / `cache_creation_input_tokens` |
| **DeepSeek** | **自动上下文缓存（内容寻址，无需声明）** | ❌ **不能**，且**不需要** | **`usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`** |

**DeepSeek 的特殊之处：缓存是自动的，但幸好 —— 它把命中情况直接报在 usage 里。**

这是三家之中**最容易验证**的一家：不用看请求体，直接看返回值。

### 3.2 DeepSeek 侧的验收标准（替代 006 §3.3 的通用三条）

#### 标准 D1 · 相同前缀 → 第二次调用 `prompt_cache_hit_tokens > 0`

同一段 system 前缀、连续两次调用，第二次的 `usage.prompt_cache_hit_tokens` 必须大于 0。

> 注意：DeepSeek 的缓存有生效延迟（官方说明通常需要几秒到几分钟，且要求前缀足够长）。若首轮测试命中为 0，**允许间隔一段时间重试**，但必须如实记录"第一次未命中、第 N 次命中"以及间隔时长。**不许为了让数字好看而篡改 usage。**

#### 标准 D2 · 前缀内容改变 → 命中数下降或归零

换一段完全不同的 system 前缀，`prompt_cache_hit_tokens` 应当显著下降或为 0。

#### 标准 D3 · `TokenUsage` 结构要能表达缓存

现有 `TokenUsage` 有 `tokensIn` / `tokensOut` / `cachedTokens`。要求映射清楚：

```
tokensIn     = usage.prompt_tokens
tokensOut    = usage.completion_tokens
cachedTokens = usage.prompt_cache_hit_tokens
```

**并写入 `UsageRecord.cachedTokens`**（schema 里这个字段已存在）。这样 `UsageRecord` 才能真实反映"省了多少钱"。

### 3.3 若 D1 不成立

如果多次重试后 `prompt_cache_hit_tokens` 始终为 0，**不要伪造**。正确做法：

- 在 `docs/architecture.md` 写明「DeepSeek 自动前缀缓存在本机环境下未观测到命中」
- 报告里如实标注「此项未验证」
- 继续 M2 的其他验收

**M2 的验收不依赖前缀缓存命中**——它依赖的是 `extract` / `card` 的 span 溯源正确性。缓存是成本优化，不是正确性前提。

---

## 4. 解除阻塞后，M2 剩余验收项

以下项现在**都可以做了**，但**必须排在 SG-SUP-008 的三项修复之后**（P0 指纹、P1 文字层闸门、P1 chunk 截断），因为它们决定了下游数据的可信度。

### 4.1 `extract` 执行器

| 要求 | 说明 |
| --- | --- |
| 输入 | `ChunkSet`（220 个 chunk，来自 10 份 PPTX） |
| 输出 | `ConceptClaims`，每条必须有 `spanIds[]` |
| 结构化 | 用 `response_format: json_object` + 显式 JSON 指令，**不许正则解析自由文本** |
| 无 span 的 claim | 标 `UNVERIFIED`，**不得进入下游 card** |
| 提示词 | 要求模型**只从给定文本抽取**，禁止补充外部知识。这一句必须出现在 prompt 里，且要做成 `promptVersion` 的一部分 |

**`promptVersion` = `sha256(promptText).slice(0,12)`** —— 006 §1 已定，此处重申。

### 4.2 `card` 执行器

| 要求 | 说明 |
| --- | --- |
| 输入 | `ConceptClaims`（**不许从零生成**） |
| 引用 | 每条入卡论断必须有可 resolve 的 span |
| 落库顺序 | 先建 `UNVERIFIED` → 写 `ConceptCitation` → 置 `VERIFIED`（触发器会拦错序） |
| 无 span | 不产卡 |

### 4.3 概念卡数量

按 SG-SUP-007 §4 执行：

- 目标 ≥15，允许下调到 ≥10，但**必须先证明材料不够**
- 回报必须分别列出：`claims 产出数` / `落库 Concept 数` / `其中 VERIFIED` / `其中 UNVERIFIED`

**材料现状提醒：** 266 页只有 5841 字符（非空口径），平均每页 22 字，且 46 页是纯图。**这个密度下产出 10 张以上有质量的概念卡是有挑战的**——请如实报告，不要凑数。

### 4.4 指纹缓存四场景（LLM 节点上）

| 场景 | 期望 |
| --- | --- |
| 首次运行 `extract` | 真实 tokens，`cacheHit=false` |
| 二次运行同节点同参数 | `tokensIn=0`、`tokensOut=0`、`cacheHit=true`，**不调模型** |
| 改 `chunk` 参数后重跑 `extract` | 指纹变，未命中，tokens > 0 |
| 改 `extract` 的 prompt 文本后重跑 | **指纹必须变**，未命中 |

**第 4 条是 006 §1 的翻版，会重点查。** 若 `promptVersion` 是手写常量，改 prompt 后仍命中——P0。

### 4.5 上游变更只标 stale

```
mark-stale 后：下游 card 变 STALE，且 Run 表行数不变
```

M1 已验过纯逻辑，M2 要在有 executor 的真实链路上再验一次。

---

## 5. 本轮不要做的事

| 不要做 | 原因 |
| --- | --- |
| 不要把 key 写进任何文件 | §0.1 |
| 不要为了让 D1 通过而伪造 usage | 数据造假 |
| 不要在修完 008 的三项之前跑 extract/card | 数据源不可信，白跑 |
| 不要用 `deepseek-reasoner` 跑 `extract` | 贵且慢，机械任务不需要；也会让 token 成本失控 |
| 不要跳过 A / C / E 三条外部复验命令 | 006 的冻结条款仍有效 |
| 不要为了凑 15 张卡把同一概念拆开 | 007 §4.2 |

---

## 6. 交付格式

```markdown
# 009 回报

## 0 · 密钥卫生
- `rg -n 'sk-[a-zA-Z0-9]{32,}'` 的输出（应为空）
- `git log -p --all -S 'sk-'` 的输出（应无命中）
- .env.example 里 DEEPSEEK_API_KEY 的样子（只允许空占位）

## 1 · 供应商备案
- architecture.md 的 diff（首期 2 家 → 3 家的说明）

## 2 · DeepSeek 适配器
- 复用方式：（A 参数化 / B 独立文件）
- 请求体（脱敏，验证 body 里没有 key）
- 一次真实调用的完整 usage 对象
- modelVersion 取自响应 model 字段的证据
- 缺 usage 字段时的报错输出

## 3 · 路由表
- 9 个 taskType 各自映射到哪家哪个模型

## 4 · 前缀缓存
- D1：第一次 hit_tokens=__，第 N 次 hit_tokens=__，间隔 __ 秒
- D2：换前缀后 hit_tokens=__
- D3：UsageRecord.cachedTokens 落库查询结果

## 5 · 008 的三项修复
- 源文件指纹（A 项同源）
- 文字层闸门（两份扫描件 + 10 份 PPTX 的判定结果）
- chunk 不丢字符（拼接校验）

## 6 · extract / card
- claims 数 / Concept 数 / VERIFIED / UNVERIFIED
- 抽 3 张卡，贴卡内容 + 其引用的 span 原文

## 7 · 指纹四场景
- 每场景：fingerprint 前 12 位 / cacheHit / tokensIn

## 8 · 仍未做
```

---

## 7. 一句话

> DeepSeek 把最难验的一件事变简单了：**它把缓存命中数直接写在 usage 里**。前两家要看请求体猜，这一家直接读数。所以前缀缓存这条，别再拿"机制不支持"当理由。

---

*监理 · SG-SUP-009*
