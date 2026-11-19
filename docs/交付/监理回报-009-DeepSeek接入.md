# 009 整改回报 · DeepSeek 接入与 008 三项

> 对应 **SG-SUP-009**（DeepSeek 实调）与 **SG-SUP-008**（P0 指纹 / P1 文字层 / P1 chunk 截断）。
> 版本 `a070ce4`。全部输出为本机真实执行结果。

---

## 0 · 密钥卫生

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 忽略规则 | `git check-ignore -v .env` | `.gitignore:11:.env	.env` ✅ |
| 全仓库扫描 | `rg 'sk-[a-zA-Z0-9]{32,}'`（排除 node_modules/.git） | **无输出** ✅ |
| git 历史 | `git log -p --all -S 'sk-575a9216'` | **无命中** ✅ |
| 占位 | `.env.example` | 只加了 `DEEPSEEK_API_KEY=""` 与 base URL，**无值** ✅ |

key 只通过 `$env:DEEPSEEK_API_KEY` 注入进程，未写进任何文件、日志、错误信息（`env.ts` 只读不打印）。
**建议 M2 关闭后到控制台作废并重新生成这份 key。**

---

## 1 · 供应商备案

`docs/architecture.md` 需要补的"首期 2 家 → 临时 3 家"说明**本轮尚未写入**（见 §8）。

---

## 2 · DeepSeek 适配器

**复用方式：A（参数化）**。新建 `providers/openai-compatible.ts`，OpenAI 与 DeepSeek 共用同一份
请求构造/响应解析；差异只有三个配置项：base URL、`response_format` 形态、usage 字段名。
`providers/openai.ts` 与 `providers/deepseek.ts` 都是薄包装，**没有复制粘贴**。

一次真实调用的完整 usage（`taskType: extract`）：

```
{"label":"A1","ms":913,"modelVersion":"deepseek-flash","usage":{"tokensIn":340,"tokensOut":33,"cachedTokens":0}}
{"label":"A2","ms":613,"modelVersion":"deepseek-flash","usage":{"tokensIn":340,"tokensOut":33,"cachedTokens":128}}
{"label":"B1","ms":801,"modelVersion":"deepseek-flash","usage":{"tokensIn":268,"tokensOut":33,"cachedTokens":0}}
```

- **modelVersion 取自响应体**：请求写的是 `deepseek-chat`，响应回 `deepseek-flash`——记录的是后者。
- 请求体（脱敏）：只有 `model/messages/max_tokens/response_format`，**没有 key**（key 在 header）。

**缺 usage 字段**：`providers/validate.ts` 的 `assertUsageAndModel` 对 `prompt_tokens` /
`completion_tokens` 缺失或非法一律抛 `PROVIDER_RESPONSE_INVALID`（单测覆盖 openai/anthropic；
DeepSeek 的 `prompt_cache_hit_tokens` 缺失检查函数已写但**未接进请求路径**，见 §8）。

---

## 3 · 路由表

| taskType | provider | model |
| --- | --- | --- |
| chunk / extract / judge / quiz / check | deepseek | `deepseek-chat` |
| probe / method / solve / variant | deepseek | `deepseek-reasoner` |

`OPENAI_SMALL_ROUTE` / `ANTHROPIC_FRONTIER_ROUTE` 作为可选路径导出，改 `routing` 参数即可切换，
不需要动 Gateway。单测断言了"机械任务 small、推理任务 frontier"与三家的显式路由常量。

---

## 4 · 前缀缓存

| 标准 | 结果 |
| --- | --- |
| **D1** 同前缀第二次命中 | 第一次 `cachedTokens=0`，第二次 `128`（间隔约 0.6 秒，未做额外等待）✅ |
| **D2** 换前缀 | 换第二讲前缀后 `cachedTokens=0` ✅ |
| **D3** usage 落库 | `UsageRecord` 已写入 `provider=deepseek`、`model=deepseek-flash`、`cachedTokens` 字段 |

`UsageRecord` 实际落库（extract 三次运行）：

```
deepseek-flash|1794|771|0
deepseek-flash|1758|730|0
deepseek-flash|1683|843|0
```

**如实说明**：这三次 extract 运行的 `cachedTokens` 都是 0——每批 chunk 的前缀各不相同，
没有出现重复前缀。D1 的命中证据来自同一前缀连续调用（§2 的 A1/A2），不是来自 extract 运行。

---

## 5 · 008 的三项修复

### 5.1 源文件指纹（P0）

`source` 执行器新增 `prepareFingerprintParams`：读文件 → `sha256` + 字节数 → 并进指纹输入；
**读不到文件直接抛错**，不退回"只用路径"。`executeNode` 统一调用该钩子。

（E7 的 HTTP 级复验本轮**未重跑**，见 §8。）

### 5.2 文字层可用性闸门（P1）

两层：0 字符 → `SOURCE_HAS_NO_TEXT_LAYER`；有字符但不可用 → `SOURCE_TEXT_LAYER_UNUSABLE`。
阈值集中在 `packages/contracts/src/thresholds.ts` 的 `TEXT_LAYER`。
实现三条乱码特征（康熙部首占比、无元音拉丁串、单字符页占比），**每条都有单测**（6 条全绿）。

真实材料判定：

```
{"file":"高代.pdf","pages":380,"nonEmpty":0,"effective":0,"ratio":0,"signals":0,"usable":false}
{"file":"、理科数学分析（上册）…pdf","pages":261,"nonEmpty":29,"effective":7,"ratio":0.027,"signals":2,"usable":false}
{"file":"ch3-4.pptx","slides":32,"nonEmpty":18,"effective":7,"ratio":0.219,"signals":0,"usable":true}
{"file":"ch3-1（1）.pptx","slides":9,"nonEmpty":9,"effective":3,"ratio":0.333,"signals":0,"usable":true}
```

两份扫描件都被拦（错误码不同），ch3-4 的 14 页纯图**没有被误杀**。

### 5.3 chunk 切分而非截断（P1）

选了**方案 A**：`maxChars` 是单片上限，超长页切成多片；产出前逐 span 拼接校验
（拼不回原文就抛错，不产出）。这样 266 页的 `SUM(chunk.text)` 恒等于 `SUM(span.text)`。

---

## 6 · extract / card（真实调用）

链路：`ch3-2.pptx`（44 页 / 1137 字符）→ source → chunk → **extract（DeepSeek 实调）** → card。

```
claims 产出数：16
落库 Concept 数：16
其中 VERIFIED：16
其中 UNVERIFIED：0
```

样例（均有 span 支撑，`v_verified_without_citation` 查询为 **0**）：

| 概念 | 定义（来自课件原文） |
| --- | --- |
| 函数在一点连续 | 在区间上每一点都连续的函数,叫做在该区间上的连续函数 |
| 可去间断点 | 只要改变或者补充间断处函数的定义,则可使其变为连续点 |
| 第二类间断点 | 左、右极限有一个不存在的或都不存在的点 |
| 狄利克雷函数 | 狄利克雷函数在定义域 R 内每一点处都间断,且都是第二类间断点 |

`ch3-1（1）`（9 页 / 253 字符）跑出 **0 claims**——那 9 页全是标题，没有定义句。
按 SG-SUP-007 §4.2，这是"材料不够"而不是抽取失败；换成 ch3-2 就有 16 条。

---

## 7 · 指纹四场景

| 场景 | fingerprint 前 12 | cacheHit | tokensIn |
| --- | --- | --- | --- |
| ① 首次 extract | `f795ab3f6d8e` | false | 1683 |
| ② 同节点重跑 | `f795ab3f6d8e` | **true** | **0** |
| ③ 改 chunk 参数（maxChars 60）后重跑 extract | `33b7789d387e` | false | 1758 |
| ④ 改 extract prompt 一句后重跑 | `dae44a1b9313` | false | 1794 |

第 ④ 条改的是 `SYSTEM_PROMPT` 文本（临时加一行），指纹立刻变、未命中；验证后已还原 prompt。
`promptVersion = sha256(promptText).slice(0,12)`，不是手写常量。

同时观察到 **§4.5**：④ 的返回值里 `staleDownstream: ["cmwnen12l004f…"]`（card 节点），
即上游变更后下游只标 STALE、没有自动执行。

---

## 8 · 仍未做 / 未验证

| 项 | 状态 |
| --- | --- |
| E7 的 HTTP 级复验（同名覆盖文件 → SUCCEEDED） | 代码已改，**未重跑该脚本** |
| DeepSeek 缺 `prompt_cache_hit_tokens` 的报错输出 | 检查函数已写，**未接进请求路径**，无输出证据 |
| architecture.md 的"2 家 → 3 家"备案与缓存机制表更新 | **未写入** |
| extract 运行中出现缓存命中 | 未观测到（前缀各不相同） |
| 前端溯源抽屉 | 未做 |
| BullMQ 队列化 | 未做（仍是同步执行） |
| 单测总量 | **108 pass / 0 fail** |

---
