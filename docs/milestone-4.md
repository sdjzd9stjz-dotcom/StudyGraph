# M4 · 开放能力 —— 验收记录

> 2026-11-21。规格 M4：REST + SSE / MCP server / PAT 鉴权 / 克隆接口。

---

## 1. 交付

| 项 | 落点 | 状态 |
| --- | --- | --- |
| PAT 鉴权 + scope | `apps/api/src/plugins/auth.ts`（M1 起就有） | ✅ |
| 运行事件流（SSE） | `GET /v1/runs/:id/events` · `apps/api/src/routes/runs.ts` | ✅ |
| 克隆接口 | `POST /v1/canvases/:id/clone` | ✅ |
| MCP server | `apps/mcp/server.mjs`（stdio JSON-RPC） | ✅ 8 个工具 |

---

## 2. SSE：为什么同步执行也要有事件流

M2 的执行是同步的，`POST /nodes/:id/run` 返回时已经跑完。
所以这个流通常是"补发已经发生的事"，而不是实时推送。仍然实现，是因为契约要求
客户端只用一条通道就能同时处理同步与将来的异步执行。

设计取舍写死在代码注释里：

- 已结束 → 立刻发 `run.snapshot` + `run.terminal` 并关闭
- 未结束 → 每 500ms 查库，状态变化推 `run.status`，终态推 `run.terminal`，120s 超时推 `run.timeout`
- **不编造中间态**：没有 QUEUED→RUNNING 就不发，客户端不能假设一定收到"开始"事件

### 实测

```
1) 执行: SUCCEEDED runId: cmwpooytj0003q5l4q3e5d8gu
2) SSE content-type: text/event-stream; charset=utf-8
2) 事件序列: run.snapshot -> run.terminal
2) 终态: SUCCEEDED
```

---

## 3. 克隆：只复制结构，不复制别人的学习成果

```
POST /v1/canvases/:id/clone
```

复制节点（参数保留、状态重置为 `DRAFT`）与连线；**不**复制产物、概念卡、课件。
理由：克隆者拿到的应该是"一套可以自己重跑一遍的流程"，而不是原作者已经抽好的知识点。
节点 id 全部重发 —— 数据库的复合外键 `(canvasId, nodeId)` 保证跨画布连线写不进去。

署名：`forkedFromId` + `originAuthorName`，原作者 `forkCount` +1。

### 实测

```
3) 克隆: {"nodes":1,"edges":0,"forkedFrom":true,"署名":"本机用户"}
3) 克隆画布节点状态: SOURCE=DRAFT
3) 克隆画布概念数（应为 0）: 0

# 直接查库确认自增
M4 开放能力|1|f
M4 开放能力 副本|0|t
```

---

## 4. MCP Server

`apps/mcp/server.mjs`，纯 Node、零依赖，MCP over stdio（每行一条 JSON-RPC 2.0）。

**只暴露真实存在的工具**：

```
canvas.create  canvas.get  canvas.clone  node.create  node.run
graph.query    review.due  concept.grade
```

规格里列的 `methods.match` / `problems.generate` / `papers.assemble` / `analytics.errors`
依赖 M5 / M6，现在还没有 —— 它们**不在** `tools/list` 里，而不是返回空实现。
外部 Agent 拿到空结果会当成"没有数据"，那是最坏的误导。

### 实测

```
initialize: studygraph | protocol 2024-11-05
工具清单: canvas.create, canvas.get, canvas.clone, node.create, node.run, graph.query, review.due, concept.grade
canvas.create: ok | isError: false
graph.query(knowledge): nodes = 0 | view = knowledge
未实现工具 methods.match: JSON-RPC 错误 -32602（未知工具…）
未知工具: JSON-RPC 错误 -32602
```

### 错误语义

- **未知工具** → JSON-RPC 错误 `-32602`（协议层：你调了不存在的东西）
- **工具执行失败**（如画布不存在）→ `result.isError: true` + 文本
  （业务层："调用成功但业务失败"，不能被客户端当成协议故障）

这两条分开是刻意的：混在一起会让 Agent 无法区分"我调错了"和"操作没成功"。

---

## 5. 环境变量

```bash
STUDYGRAPH_API_BASE_URL   API 地址（桌面版每次启动才定端口，必须运行时给）
STUDYGRAPH_DEV_PAT        PAT 明文
```

启动示例：

```bash
STUDYGRAPH_API_BASE_URL=http://127.0.0.1:54501 STUDYGRAPH_DEV_PAT=sg_pat_xxx node apps/mcp/server.mjs
```

---

## 6. 未完成 / 未验证

- **Webhook 只建了表，没有投递器**。`WebhookEndpoint` / `WebhookDelivery` 在 M1 就落库了，
  但没有任何代码触发 `node.run.completed` 这类事件。规格把它归在 M4 的鉴权段之后，
  本轮未做 —— 不写成"已完成"。
- **OAuth2 未做**，只有 PAT。规格写的是「OAuth2 + PAT」，PAT 一直可用，OAuth2 需要授权服务器，
  桌面版场景下优先级低于 PAT。
- **MCP 的 methods.* / problems.* / papers.* 工具**要等 M5 / M6。
- SSE 的 `run.status` 分支在同步执行下几乎走不到（执行在请求内就完成了），
  所以这条路径**没有实机跑过**，只验证了 snapshot → terminal 这条主路。
- 克隆不复制画布描述（description），只复制标题。

---

## 7. 验证脚本

```bash
# 需要先起客户端
node --experimental-strip-types tmp/e2e-m4.mjs    # SSE + 克隆
node --experimental-strip-types tmp/e2e-mcp.mjs   # MCP 8 个工具
```
