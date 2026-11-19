# M2 · 执行链路

> **状态：基础设施与契约层已落地；四个节点（source/chunk/extract/card）未开工**
> 两个硬阻塞见 §1，它们不解决，§4.3 的四节点与 ≥15 张概念卡无法验收。

---

## 0. 进度

| 项 | 状态 |
| --- | --- |
| Redis 容器 | ✅ healthy，`PING → PONG` |
| S3 兼容存储 | ✅ SeaweedFS（MinIO 已下架，见 §2），put/get/delete 往返 sha256 一致 |
| BullMQ / ioredis / @aws-sdk/client-s3 | ✅ 已装（版本见 `apps/api/package.json`） |
| `LLMGateway` 接口 + 两个 provider | ✅ 代码路径与单测完成；**未真实调用**（无凭据） |
| `routing.ts` 表 | ✅ 9 个 taskType → 小模型 / 前沿模型 |
| BYOK（AES-256-GCM） | ✅ 加解密往返 + 篡改检测 + 无主密钥拒绝 |
| 指纹算法 | ✅ 10 条断言（含"改 prompt 一个字必须变"） |
| `SpanResolver` 校验 | ✅ 8 条断言（text 不符 / 零长度 / 越界 / 缺页 / 空白） |
| registry + 自检 | ✅ 0 implemented + 17 planned = 17，未实现节点 501 |
| `POST /v1/nodes/:id/run` | ✅ dryRun 与正式执行都 501（未实现就明确失败） |
| `source` / `chunk` / `extract` / `card` | ⬜ **未实现**（阻塞于真实 PDF 与模型凭据） |
| span 溯源抽屉（前端） | ⬜ 未做（依赖 `card` 产物） |
| 真实 60 页 PDF 验收 | ⬜ 无文件 |

---

## 1. 两个硬阻塞（SG-SUP-004 §0）

### 阻塞 A · 没有模型凭据

```
OPENAI_API_KEY   = 空
ANTHROPIC_API_KEY= 空
BYOK_ENCRYPTION_KEY = 已配（本地生成的 32 字节 base64，仅用于演示加解密）
```

`Gateway` 在没有 key 时的行为已按契约实现并有单测：**503 `LLM_CREDENTIAL_MISSING`**，
不会返回空对象、也不会伪装成功。真实调用一次（拿到厂商 usage）必须等 key。

### 阻塞 B · 没有真实 60 页 PDF

`source` 的 span 偏移定义已经定死（见 `docs/architecture.md` §3.1），
解析器、checksum、pageCount、扫描版拒识都还没写——因为**写了也没法按规格验收**。
需要你提供一份真实课件 PDF（路径），我按 §3.5 一次做到位。

---

## 2. 环境变更：S3 从 MinIO 换成 SeaweedFS

实测（2026-11-19）：

| 尝试 | 结果 |
| --- | --- |
| `docker pull minio/minio:latest` | `pull access denied ... repository does not exist`（MinIO 已迁离 Docker Hub） |
| `quay.io/minio/minio:latest` | `401 UNAUTHORIZED`（quay 的 token 认证在代理链路上拿不到） |
| `bitnami/minio` | `not found`（Bitnami 免费镜像已下架） |
| `dl.min.io/.../minio.exe` | HTTP **410 Gone** |

改用 **SeaweedFS 的 S3 网关**（`chrislusf/seaweedfs`，Docker Hub 可拉）。
`ObjectStore` 只依赖 S3 协议，换回 MinIO 只改 image 与端口，代码不动。

> 另：Docker daemon 原先直连 registry 会撞 `x509: certificate signed by unknown authority`，
> 已在 Docker Desktop 里配代理 `127.0.0.1:7897`（备份见 `%APPDATA%\Docker\settings-store.backup.json`）。

---

## 3. 已实现的契约层

| 模块 | 位置 | 说明 |
| --- | --- | --- |
| 产物 schema（zod） | `packages/contracts/src/artifacts/` | SourceDoc / ChunkSet / ConceptClaims / ConceptCard / SpanRef |
| 指纹 | `packages/contracts/src/fingerprint.ts` | `canonicalJson` + `promptVersionOf(prompt 文本)` + `computeFingerprint` |
| LLM 类型与路由 | `apps/api/src/llm/{types,routing,gateway}.ts` | 9 个 taskType → 模型；失败抛 AppError |
| 两个 provider | `apps/api/src/llm/providers/{openai,anthropic}.ts` | 结构化输出；usage 与 modelVersion 取厂商响应 |
| BYOK | `apps/api/src/llm/byok.ts` | AES-256-GCM；主密钥不落库 |
| 执行器契约 | `apps/api/src/nodes/contract.ts` | 与规格字段一致 |
| 注册表 | `apps/api/src/nodes/registry.ts` | 17 类型自检 + 501 |
| span 校验 | `apps/api/src/spans/resolver.ts` | 逐字符比对，带缓存 |
| 对象存储 | `apps/api/src/storage/object-store.ts` | 真 S3（M1 的空实现已替换） |

---

## 4. 验收记录

### 4.1 基础设施

```
$ docker compose ps
postgres  Up 30 minutes (healthy)
redis     Up 16 minutes (healthy)
s3        Up 15 seconds            ← 无 healthcheck，见下

$ docker exec studygraph-redis redis-cli ping
PONG
```

S3 往返（`node tmp/s3-roundtrip.mjs`）：

```
{ "storeKind": "s3", "putBytes": 65536, "gotBytes": 65536,
  "sha256": "8b50b8e1…73a800", "shaMatch": true }
deleteMany: {"deleted":1,"orphanKeys":[]}
✅ 删除后读回失败: NoSuchKey
```

> SeaweedFS 镜像里没有 wget/curl，任何容器内探针都是假红，所以不设 healthcheck；
> 就绪性用上面的往返校验证明（比探针更强）。

registry 自检（`node scripts/registry-self-check.mjs`）：

```
implementedCount: 0, plannedCount: 17, unionSize: 17, ok: true, problems: []
```

未实现节点的 501：

```
dryRun     501 {"code":"EXECUTOR_NOT_IMPLEMENTED","details":{"type":"CHUNK","plan":"M2"}}
正式执行    501 {"code":"EXECUTOR_NOT_IMPLEMENTED","details":{"type":"CHUNK","plan":"M2"}}
不存在的节点 404 {"code":"NODE_NOT_FOUND"}
```

### 4.2 Gateway

| 场景 | 结果 |
| --- | --- |
| 无凭据 | 503 `LLM_CREDENTIAL_MISSING`（单测） |
| 厂商 401 | 502 `LLM_PROVIDER_ERROR`（单测，注入假 fetch） |
| 成功路径 | usage = 厂商返回的 `prompt_tokens/completion_tokens/cached_tokens`；`modelVersion` = 响应里的真实标识 |
| 真实调用 | ⬜ 无 key，未做 |

routing：`chunk/extract/judge/check/quiz → 小模型`，`probe/method/solve/variant → 前沿模型`，
两个 provider 都被覆盖（单测断言）。

### 4.3–4.7 四节点 / 无源拦截 / 指纹缓存行为 / 显式触发 / 前端

**未做**。指纹算法本身有 10 条断言，但"二次运行 tokensIn=0"这类行为依赖执行链路，
没有 executor 就没有 Run 记录，写不出真实证据。

### 4.8 单元测试

| 文件 | pass | fail |
| --- | --- | --- |
| `packages/contracts/test/ports.test.ts` | 27 | 0 |
| `packages/contracts/test/fingerprint.test.ts` | 10 | 0 |
| `apps/api/test/unit/dag.test.ts` | 13 | 0 |
| `apps/api/test/unit/auth.test.ts` | 10 | 0 |
| `apps/api/test/unit/spans.test.ts` | 8 | 0 |
| `apps/api/test/unit/registry.test.ts` | 6 | 0 |
| `apps/api/test/unit/gateway.test.ts` | 7 | 0 |
| `apps/api/test/integration/downstream-equivalence.test.ts` | 2 | 0 |

---

## 5. M1 结转欠债

| # | 内容 | 本章处置 |
| --- | --- | --- |
| 1 | 拖拽的浏览器内验证 | ⬜ 未做（M2 前端未动） |
| 2 | 对象存储删除是空实现 | ✅ 已接真 S3，`deleteMany` 返回真实 `deleted/orphanKeys` |
| 3 | 前端 PATCH 无防抖 | 延至 M3 |
| 4 | `next build` 依赖 `externalDir` | 延至 M3 |
| 5 | 前端无登录态 | M4 |

---

## 6. 下一步（等两个输入）

1. **模型 key**：给我一个厂商的 key（以及要不要走 BYOK 路径），我先把 `extract` 跑通一次真调用。
2. **真实 PDF**：给路径与页数，我完成 `source`（含扫描版拒识）→ `chunk` → `extract` → `card`。

这两样一到，§4.3 之后的验收我按天推进，不再有未验证项。
