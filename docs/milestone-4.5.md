# M4.5 · 新能力（F2 / G1 / H1）—— 验收记录

> 2026-11-21。规格：`StudyGraph-Agent-Prompt.md` §新能力。
> 本文只写**已跑通并留下终端原文**的行为；没密钥验不了的地方明确标出来。

---

## 1. 交付

| 代号 | 内容 | 落点 | 状态 |
| --- | --- | --- | --- |
| F2 | Skill 指令包 | `Skill` / `NodeSkill` 两表 + 指纹 + 注入 | ✅ 核心约束已实测 |
| G1 | 对话式编排草案 | `GraphDraft` 表 + `/v1/canvases/:id/drafts` 等 | ⚠️ 代码就位，**生成未实调**（无模型密钥） |
| H1 | 兼容网关 | `/v1/models`、`/v1/chat/completions`、`/v1/messages`、`/v1/embeddings` | ⚠️ `/v1/models` 已实测；其余**未实调** |

迁移：`20261121020000_skill_and_draft`（4 张表，含 2 个内置 skill 种子）。

---

## 2. F2：指纹这一条是全部要害

规格原文：

> 绑了哪些、各自 `version` 多少，**全部进指纹**——否则「加了 skill 却命中旧缓存」就是 A 项错误的翻版

实现：

- `apps/api/src/nodes/skills.ts` —— 读绑定、算指纹载荷、拼 system 前缀
- `execute.ts` 把 `[{ slug, version }]` 并进 `computeFingerprint` 的 params
- 只放 slug + version，不放正文：正文改了 version 必然 +1，塞全文是浪费

### 实测（真机，dryRun）

```
未绑 skill 指纹: 8919c32f699e0afb
绑定后指纹  : 8b354c5a231fd8e5
指纹是否改变: ✅ 变了
解绑后指纹是否回到原值: ✅ 是
```

第三行同样重要：解绑能回到原指纹，说明载荷是**确定性的**（按 slug 排序、不含随机量），
不是「只要变了就行」。

### 其余 F2 实测

```
内置 skill: chinese-math-notationv1, citation-strictv1
新建 USER skill: my-test-skill v1
改正文后版本: v2 (应为 v2)
改不存在的 skill: 404
```

改正文 → version +1；改名字**不**+1（只改 name 不该让全画布缓存失效）。

### 注入顺序

`apps/api/src/nodes/skills.ts` 固定为：

```
硬约束摘要 → skill（按 slug 排序）→ 节点 prompt
```

硬约束放在最前，并在 skill 段落标题里写明「若冲突以硬约束为准」——
不靠「让模型听话」，靠位置与显式声明。

---

## 3. G1：草案

`POST /v1/canvases/:id/drafts` 生成草案、`/accept` 落画布、`/discard` 丢弃。

三条约束的实现方式：

| 约束 | 怎么保证 |
| --- | --- |
| 不落画布、不执行 | 草案只写 `GraphDraft`；`accept` 建出的节点一律 `DRAFT`，返回里显式带 `executed: false` |
| 必须显式确认 | 状态机 `PROPOSED → ACCEPTED / DISCARDED`，非 PROPOSED 再确认返回 409 |
| 落盘走同样校验 | `accept` 重新跑 `isNodeType` 与 `validateConnection`，任何一条不合法就整体拒绝（落一半的图比不落更糟） |

生成草案那一次模型调用**计入 `UsageRecord`**（surface=`NODE_RUN`）——
它是真花了 token，不能装作免费。

### 实测

```
生成草案（无模型密钥）: 503 LLM_CREDENTIAL_MISSING
确认不存在的草案: 404
```

**未验证**：草案的实际生成、字段完整性、落画布后的图形态。
本机没有可用的模型密钥，这部分只能等接上密钥再验。

---

## 4. H1：兼容网关

| 端点 | 实现 |
| --- | --- |
| `GET /v1/models` | 用户凭据下的模型 ∪ 路由表模型，去重排序，不含任何凭据信息 |
| `POST /v1/chat/completions` | 上游 SSE **原样转发**，只在尾部解析 usage 记账 |
| `POST /v1/messages` | Anthropic 形状（含 system 抽取与 content 数组拍平） |
| `POST /v1/embeddings` | 同一解析链；返回里带 `studygraph.dimension` 与 `expectedDimension: 1536` |

**调用方指定 `apiKey` / `baseUrl` 会被静默忽略**（schema 里接受但不用），
这是规格约束 1 的落点：只能选模型名，凭据由服务端解析。

流式的取舍：不自己重组 chunk，直接转发上游 SSE。自己拼极易丢 vendor 扩展字段，
客户端就解析不了。

### 实测

```
/v1/models 数量: 2 | 示例: deepseek-chat, deepseek-reasoner
chat/completions（无密钥）: 400 NO_MODEL_CONFIGURED
无 token 调用: 401
```

`apiKey: 'sk-should-be-ignored'` 与 `baseUrl: 'http://evil'` 都传了，
结果是 `NO_MODEL_CONFIGURED` 而不是去连 `evil` —— 说明确实被忽略了。

**未验证**：真实上游调用、SSE 流式、embeddings、messages 端点的实际返回。
同样因为本机没有模型密钥。

---

## 5. 未完成 / 未验证

- **F2 的注入效果没有实调**。指纹链路验证了，但「skill 正文真的进了 system 前缀并影响输出」
  没有跑过——需要模型密钥。
- **G1 生成草案完全未验证**，只验证了错误路径（无密钥 503、确认不存在的草案 404）。
- **H1 四个端点只有 `/v1/models` 与错误路径验证过**。流式、embeddings、messages 都未实调。
- 草案管理的界面未做（只有 API）。
- `/v1/skills` 的前端管理页未做。

> 按 §8 纪律：上面这些**不写成已完成**。

---

## 6. 验证脚本

```bash
# 需要先起客户端
node --experimental-strip-types tmp/e2e-m45.mjs
```
