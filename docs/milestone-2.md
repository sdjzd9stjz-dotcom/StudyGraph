# M2 · 执行链路

> **状态：基础设施与契约层已落地；四个节点（source/chunk/extract/card）未开工**
> 两个硬阻塞见 §1，它们不解决，§4.3 的四节点与 ≥15 张概念卡无法验收。

---

## 0. 进度

| 项 | 状态 |
| --- | --- |
| Redis 容器 | ✅ 真实证据：`redis-cli ping → PONG`，容器 `(healthy)` |
| S3 兼容存储 | ✅ SeaweedFS：`scripts/s3-roundtrip.mjs` 往返 sha256 一致；容器 `(healthy)`，探针 `curl -sf :8333/` |
| BullMQ / ioredis / @aws-sdk/client-s3 | ✅ 已装 ⚠ **队列未接线**（没有 executor，接了只能空跑） |
| PDF 解析库 | ✅ `unpdf` 已装（`require.resolve` 有路径）；解析器代码随真实 PDF 一起写 |
| `LLMGateway` 接口 + 两个 provider | ✅ 代码与单测；⚠ **未真实调用**（无 key） |
| `routing.ts` 表 | ✅ 9 个 taskType → 小模型 / 前沿模型 |
| BYOK（AES-256-GCM） | ✅ 加解密 + 篡改检测 + 无主密钥拒绝 + **已接线到认证链**（`credentials.ts` → `routes/system.ts`） |
| 前缀缓存键 | ✅ `cachePrefixKey` 影响出站请求体（`prompt_cache_key`），单测断言 `sameRequest=false` |
| 指纹算法 | ✅ 10 条断言（含"改 prompt 一个字必须变"） |
| `SpanResolver` 校验 | ✅ 10 条断言；缓存**绑定原文版本**（SG-SUP-005 A），原文变更后必判失败 |
| 引用漂移巡检 | ✅ `citation-integrity.ts`：真实卡片在原文变更后降级 `UNVERIFIED`（实测） |
| registry + 自检 | ✅ 双向差集自检 + **启动路径调用**，不通过拒绝启动；未实现节点 501 |
| `POST /v1/nodes/:id/run` | ✅ dryRun 与正式执行都 501（未实现就明确失败） |
| `source` / `chunk` / `extract` / `card` | ⬜ **未实现**（阻塞于真实 PDF 与模型凭据） |
| span 溯源抽屉（前端） | ⬜ 未做（依赖 `card` 产物） |
| 真实 60 页 PDF 验收 | ⬜ 无文件 |

> 上一版这张表把"已装依赖"写成了"已完成准备项"，且启动路径没调自检（SG-SUP-005 B/C）。
> 现在每一行都对应一条可复跑的命令，见 `docs/交付/监理回报-006-SG-SUP-005整改.md`。

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

---

## 7. 2026-11-20 · 环境恢复后的第一批（M2 收尾 §3.4 第 2 / 7 / 13 项）

> **本文件 §0–§6 写于 M2 早期，已严重过时**（那里说四节点未实现，而实际 10 份 PPTX 已跑出 40 次 SUCCEEDED、
> 266 页 / 220 span、27 条候选 → 7 张 VERIFIED）。未重写旧段落，只在本节记录本轮实测。
> 当前权威台账是 `docs/监理交接-状态快照.md` §5。

### 7.1 环境（env-check 原文）

```
docker engine  : OK (29.9.3)
postgres       : OK (PostgreSQL 16.16 (Debian 16.16-1.pgdg12+1) on x86_64-pc-linu)
redis          : OK
s3             : OK (SeaweedFS, HTTP 200)
deepseek key   : MISSING
deepseek probe : SKIP (no key)

❌ 环境未就绪：后续步骤不执行
=== EXIT: 1 ===
```

容器身份复核：`pgvector/pgvector:pg16` + `PostgreSQL 16.16` + `pgvector 0.8.7`，三容器 healthy。
**LLM key 仍缺**，所以 4 / 8 / 9 / 10 / 11 项（依赖模型调用的全链路重跑与校准）依然不做。

### 7.2 §3.4 第 2 项 · 迁移两路径

**空库路径**（临时库 `studygraph_emptycheck`，一次 deploy 全部 7 份）：

```
7 migrations found in prisma/migrations
Applying migration `20261118030000_init`
Applying migration `20261118030100_guards`
Applying migration `20261119000000_edge_no_self_loop`
Applying migration `20261119000000_pending_review_enum`
Applying migration `20261119000100_pending_review_guards`
Applying migration `20261120000000_span_region`
Applying migration `20261120000100_card_review_decision`
All migrations have been successfully applied.
=== EXIT: 0 ===
```

形状：`tables=39 checks=8 triggers=6 views=4`，枚举 29 个（现库 28 → 差的就是 `PENDING_REVIEW`）。

**老库路径**（现库 `studygraph`，升级前先 `pg_dump -Fc` 到 `.tmp-backup/`，195 KB）：

```
7 migrations found in prisma/migrations
Applying migration `20261119000000_pending_review_enum`
Applying migration `20261119000100_pending_review_guards`
Applying migration `20261120000100_card_review_decision`
All migrations have been successfully applied.
=== EXIT: 0 ===
```

升级后：`VerificationStatus=UNVERIFIED,VERIFIED,PENDING_REVIEW,MERGED`、`ProblemStatus=PENDING,VERIFIED,REJECTED`、
`tables=39 checks=8 triggers=6 views=4`。

**行为验证**（事务内实测，结尾 `ROLLBACK`，脚本 `.tmp-backup/trigger-behavior-test.sql`）：

```
NOTICE:  NEG1 PASS: rejected, sqlstate=23514 msg=Concept tst_c1 cannot be VERIFIED without at least one source span citation
NOTICE:  NEG2 PASS: rejected, sqlstate=23514 msg=Problem tst_p_bad cannot be VERIFIED without at least one source span citation
 phase  |   ent   |  status
--------+---------+----------
 BEFORE | Concept | VERIFIED
 BEFORE | Method  | VERIFIED
 BEFORE | Problem | VERIFIED
 phase |   ent   |   status
-------+---------+------------
 AFTER | Concept | UNVERIFIED
 AFTER | Method  | UNVERIFIED
 AFTER | Problem | PENDING
view_verified_without_citation_rows=0
view_method_concept_mismatch_rows=0
```

`PENDING_REVIEW` 也不是免检口（空库上测）：无引文置 `PENDING_REVIEW` 被拒
（`T3 PASS: ... cannot be PENDING_REVIEW without at least one source span citation`），
先插引文再置 `PENDING_REVIEW` 成功（`T4 | PENDING_REVIEW`）。

- **删掉这条断言会漏什么**：只验「migrate deploy 退出码 0」会漏掉「触发器对 `Problem` 传了不存在的枚举值」
  （即 010 那次 22P02 的同型错误），以及「`PENDING_REVIEW` 被当成无引文通道」。
- 降级目标是**按实体传参**的：Concept/Method → `UNVERIFIED`，Problem → `PENDING`（`ProblemStatus` 无 `UNVERIFIED`），
  与 `20261119000100_pending_review_guards/migration.sql` 的注释一致。

### 7.3 §3.4 第 7 项 · 包级 tsc

```
node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json --noEmit
=== EXIT: 0 ===
```

`apps/api/tsconfig.json` 已存在（012 补的），`strict: true` 未降，`include` 覆盖 `src/**` + `test/**`。

### 7.4 §3.4 第 13 项 · guards-sync 反向自测（本轮发现并修了真缺陷）

**先看到的现象**：`node scripts/check-guards-sync.mjs` 原本报红——
`guards.sql 缺少 TRIGGER:concept_verified_needs_citation`，但该触发器就在 `guards.sql` 第 5 行。方向是反的。

根因有两条，都在校验器自己身上：

1. **切分器不认 dollar-quote**：按 `;` 切，PL/pgSQL 的 `RAISE EXCEPTION ...;` 把 `CREATE FUNCTION` 截断，
   两个函数对象整条丢失。
2. **语句开头的注释行未剥除**：`-- 说明\nCREATE TRIGGER ...` 这种写法因 `^CREATE` 匹配失败被跳过，
   `guards.sql` 的首条触发器与两个函数因此长期隐身。

修后重建，对象数由 6 → **12**（2 FUNCTION / 6 TRIGGER / 4 VIEW），与库里 `triggers=6 views=4` 对得上：

```
✅ 已重建 guards.sql（12 个守卫对象）
   FUNCTION:studygraph_assert_citation_before_verify  ← 20261118030100_guards -> 20261119000100_pending_review_guards
   ...
✅ guards 同步（12 个守卫对象，覆盖全部 migration）
```

**反向自测（8 条，全部要求「报红且点名该对象」）**：

```
✅ 基线：未改动时无差异 — 0 条差异
✅ 删掉触发器 → 报红且点名该对象 — TRIGGER:problem_verified_needs_citation 定义不一致…
✅ 删掉 $$ 函数 → 报红且点名该函数 — FUNCTION:studygraph_downgrade_when_last_citation_removed 定义不一致…
✅ 函数体改一个字符 → 报红且点名该函数 — …
✅ 触发器参数改值 → 报红且点名该触发器 — …
✅ guards.sql 缺对象 → 报红
✅ guards.sql 多对象 → 报红
✅ 同名重定义留下 provenance — 9 个对象记录了 20261118030100_guards -> 20261119000100_pending_review_guards
✅ 自测全部通过（8 条）
```

- **删掉这条断言会漏什么**：删掉「删 $$ 函数」一条，就无法发现切分器吞掉函数——
  而这正是修复前真实存在的状态（校验器绿，函数体随便改都不报）。
- 自测第一版写成了「只要有差异就算过」，在基线本来就红的情况下 4 条用例是蒙过去的；
  已收紧为「差异必须点名被改的对象」。

### 7.5 顺带发现（未修，登记）

| 项 | 现象 | 影响 |
| --- | --- | --- |
| `scripts/check-drift.mjs` | 本轮 `migrate diff` 仍报两条 `DROP INDEX`（`Concept_embedding_hnsw` / `Concept_name_trgm`），退出码 1 | 预期行为（Prisma 推不出 HNSW/trgm），不是缺陷；只要不生成新迁移就不受影响 |
| `tmp/build-guards-sql.mjs` | 只拼两份 migration 的旧工具，已被 `--rebuild` 取代，且 `tmp/` 在 gitignore 内 | 谁再跑一次就会把 `guards.sql` 打回 6 对象状态。建议删除 |
| `packages/db/sql/guards.sql` 可读性 | `--rebuild` 输出为单行压缩格式，丢了原先的说明注释 | 文件是「供人阅读的同步副本」，现在不好读；需要的话让生成器保留 `-- name ← 来源迁移` |

### 7.6 本轮仍未完成

- §3.4 第 1 项（DeepSeek key）、第 4/8/9/10/11 项（全链路、产物完整性、27 条校准表、三态落库数、新画布重跑）——**等 key**
- §3.4 第 3 项（写库实验 a/b/c/d + 两条降级 + 视图 0 行）——视图空已在 7.2 顺带验了，写库实验未做
- §3.4 第 5 项（巡检 A–F 落库实测）、第 6 项（复核接口四条 curl）——未做
- §3.4 第 12 项（前端溯源抽屉）——**UI 阶段，开工前需先问用户一次**
- 第 13 项（BullMQ 队列）——可延后

---

## 8. 2026-11-20 · 密钥恢复后：全链路、校准表、巡检、复核接口

> §7 之后环境恢复（DeepSeek key 可用，env-check 全绿），本节记录 §3.4 剩余项的实测。
> **口径**：只有跑过并且输出贴在上面的才算「完成」；没做的一律留空。

### 8.1 §3.4 第 8 项 · 产物完整性（**关闭**）

判定函数的输入是 `name / definition / quote / spanText`，判定产出的两个指标是
`similarity / lengthRatio`。产物里必须**全部存下来**，否则永远证明不了它对。

十份课件跑批（画布 `cmwovbcoe0001q5fsjrb5ezs2`）的断言输出：

```
{"event":"artifact-completeness","extractArtifacts":10,"claims":30,
 "byStatus":{"PENDING_REVIEW":25,"UNVERIFIED":5},
 "fields":{"quote":30,"spanText":30,"classifierVersion":30,"similarity":30,"lengthRatio":30,"total":30},
 "classifierVersions":["387fbb711ed1"],"expectedClassifierVersion":"387fbb711ed1"}
```

**离线重放**（不连库、不调模型，`node scripts/replay-calibration.mjs .tmp-backup/claims-017`）：
30/30 的重放 `verdict` 与入库 `status` 逐条一致，`a1Fail` 为 0。

- **删掉这条断言会漏什么**：旧产物（013/016 之前）只存了 7 条 quote、`spanText` 与
  `classifierVersion` 一条都没有。没有这条断言，产物缺字段会被当成正常，校准表就失去依据。

### 8.2 §3.4 第 4 项 · 纯标题全链路（**关闭**）

受控材料 `controlled-012.pptx`（脚本 `scripts/fixtures/make-pptx-fixture.mjs` 生成）
第 1 页就是「指数函数练习目录」——名称自带「指」字，正是 010 那次把纯标题送进 T1 的触发条件。

```
{"event":"extract-summary","claims":5,"byStatus":{"VERIFIED":3,"UNVERIFIED":2}}
✅ 015 收口全部断言通过（canvas cmwot6x7r0001q5nkbxzta4x4）
```

断言 B 通过：纯标题页产生的 claim **全部是 UNVERIFIED**，没有进入卡片。

- **删掉这条断言会漏什么**：这个 P0 的根因是「名称自带谓词字」，只测正常页永远测不出来。

### 8.3 §3.4 第 10 项 · 真实三态落库数（**关闭，数量口径见说明**）

| 批次 | 画布 | claims | VERIFIED | PENDING_REVIEW | UNVERIFIED |
| --- | --- | --- | --- | --- | --- |
| 旧提示词 | `cmwouqdpj0001q5a4eq7taqzk` | 26 | 0 | 11 | 15 |
| 新提示词 | `cmwovbcoe0001q5fsjrb5ezs2` | 30 | 0 | 25 | 5 |

概念表（`Concept`）落库：016 画布 11 条 PENDING_REVIEW，017 画布 19 条（同名去重后）。

**数量口径的说明（必须写清，否则会被误读）**：
`VERIFIED` 为 **0** 不是 bug。用户 2026-11-20 拍板「选 A」——T1 保持 `definition === quote`
的严格定义，而提示词要求模型用自己的话转述，两者刻意不重叠。**`VERIFIED` 只能由人工复核产生**，
§7 的「VERIFIED ≥ 10」目标改为「人工复核后可入库概念 ≥ 10」，当前 19 个（校准表口径）。

### 8.4 §3.4 第 9 项 · 校准表 + 双负例（**关闭**）

`docs/交付/校准表-017-三十条.md`，30 条逐行，人工判读列由执行方逐条读原文判定：

```
19 对 / 1 勉强 / 6 错 / 4 重复（合计 30）
```

机器与人工的分歧：**误杀 1 条**（#20 线密度，括号并列导致相似度掉到 0.313）、
**漏判 2 条**（#15/#16 把「等价无穷小替换规则」当成无穷大量的定义）。
机器准确率 23/30，**不足以自动入库**。

双负例三条（原文见校准表 §双负例）：

```
NEG1 引文真实但引错页 => UNVERIFIED A1_QUOTE_NOT_IN_SPAN
NEG2 引文在本页但定义无关 => UNVERIFIED NAME_NOT_IN_DEFINITION sim=0.000
NEG3 纯标题 => UNVERIFIED BELOW_SIMILARITY,LENGTH_RATIO_OUT_OF_RANGE
```

### 8.5 §3.4 第 5 项 · 巡检 A–F 落库实测（**关闭**）

`scripts/verify-integrity-cases.mjs`，7 个用例各自独立画布/来源/页文本/Span：

```
┌──────┬──────────────────┬──────────────────┬──────────────────────────┬──────┐
│ case │ before           │ after            │ reason                   │ ok   │
├──────┼──────────────────┼──────────────────┼──────────────────────────┼──────┤
│ A    │ VERIFIED         │ VERIFIED         │ null                     │ true │
│ B    │ VERIFIED         │ UNVERIFIED       │ UNSUPPORTED_DEFINITION   │ true │
│ C    │ VERIFIED         │ VERIFIED         │ null                     │ true │
│ D    │ VERIFIED         │ UNVERIFIED       │ TEXT_MISMATCH            │ true │
│ E    │ PENDING_REVIEW   │ PENDING_REVIEW   │ null                     │ true │
│ F    │ PENDING_REVIEW   │ UNVERIFIED       │ TEXT_MISMATCH            │ true │
│ G    │ VERIFIED         │ UNVERIFIED       │ TEXT_MISMATCH            │ true │
└──────┴──────────────────┴──────────────────┴──────────────────────────┴──────┘
{"cases":7,"passed":7,"failed":0}
```

- **C/E 是这套用例存在的理由**：若巡检被降成「一律只查 A1」，B 会漏；若被升成「一律完整 T1」，
  C 会被误杀。两个方向各有用例守着。
- 修过两次**自造污染**：①全部用例共用一个 span，G 改文本把 A/C 一起打成 TEXT_MISMATCH；
  ②为绕开名称唯一约束给概念名加了后缀，反而破坏 T1 的「名称在定义里」。

### 8.6 §3.4 第 6 项 · 复核接口四条 curl（**关闭**）

真实 API（`node apps/api/src/server.ts`，:3001）+ 真 PAT + 真库：

```
curl 1 ACCEPT 一条 PENDING_REVIEW
HTTP 200 {"id":"...","status":"VERIFIED","reviewedAt":"2026-11-20T11:15:18.360Z","reviewedBy":"..."}

curl 2 同一条再审
HTTP 409 {"error":{"code":"CONFLICT","message":"只有 PENDING_REVIEW 可以复核，当前是 VERIFIED",...}}

curl 3 非法 decision
HTTP 400 {"error":{"code":"VALIDATION_FAILED","message":"请求参数校验失败",
  "details":{"issues":[{"path":"decision","message":"Invalid option: expected one of \"ACCEPT\"|\"REJECT\""}]}}}

curl 4 并发两个裁决同一张 PENDING_REVIEW
A HTTP 200 ; B HTTP 409
```

**并发那条是关键**：CAS 若写成「先读、再判、后写」，两个请求都会看到 PENDING_REVIEW 并都返回 200。
现在一成一败，说明状态检查确实是写入条件（`updateMany where status=PENDING_REVIEW`）。
事后库校验：甲/丙 VERIFIED、乙保持 PENDING_REVIEW 未被误改。

测试用 PAT 已吊销（`revokedAt` 已写）。

### 8.7 §3.4 第 11 项 · 新画布重跑（**关闭**）

旧画布 `cmwnn9tpg0001q52wfgghlljt`（011 十份课件）保持冻结，未改动。
新画布 `cmwovbcoe0001q5fsjrb5ezs2`：10 份课件 / 40 次执行全 SUCCEEDED / 30 claims / 9269 输入 token。

### 8.8 仍未完成

| 项 | 状态 | 原因 |
| --- | --- | --- |
| §3.4 第 3 项 写库实验 a/b/c/d | **未做** | 视图 0 行已在 §7.2 验过；a/b/c/d 四组写库实验仍未做 |
| §3.4 第 12 项 前端溯源抽屉 | 未做 | UI 阶段，开工前需问用户 |
| §3.4 第 13 项 BullMQ 队列 | 未做 | 可延后（M2 为同步执行） |
| 已知假阴性 | 记录在案 | 「指数函数的定义域」这类短定义（残留 4–5 字）被 `RESIDUAL_TOO_SHORT` 拒绝。阈值 6 字是用来挡纯标题的（纯标题残留 2 字），**不降低** |
| 已知漏判 | 记录在案 | 校准表 #15/#16：结构条件满足但语义错，机器会放行，只能靠人工 |

### 8.9 环境事件（2026-11-20）

Docker Desktop 进程在跑批期间自行退出一次，WSL `docker-desktop` 停止。重启后容器与数据完好
（`ai_pgdata` 具名卷），10 个旧画布与 015–017 新画布均在。**数据无损**。
