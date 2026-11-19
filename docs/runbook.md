# 运行手册

> 记录「这台机器上怎么跑起来」以及踩过的坑。换机器时先看 §1、§4。

## 1. 环境要求

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | ≥ 22.11 | 本机 26.13.1（原生跑 `.ts`、`node:test`） |
| pnpm | 11.x | 本机 11.28.5，**不在 PATH 上**，调用方式见 §4 |
| PostgreSQL | 16 + pgvector | `Concept.embedding vector(1536)`、递归 CTE |
| Redis | 7+ | BullMQ、SSE 广播、OAuth 授权码（M2 起需要） |
| S3 兼容存储 | MinIO 即可 | 原文、切片、大产物（M2 起需要） |

## 2. 本机现状（2026-11-18）

已安装：Node 26.13.1、git 2.56.1。

**缺失：Docker、PostgreSQL、Redis、MinIO。** 因此 `pnpm db:migrate` 与任何需要连库的
验收都无法执行。`docker-compose.yml` 已就绪，装完 Docker Desktop 后
`docker compose up -d postgres` 即可（先只起 postgres，Redis/MinIO 到 M2 再说）。

## 3. 这台机器上已经踩过的坑

### 坑 1 · 工作区文件夹权限导致 shell 写不进去

现象：读写文件的工具正常，但 `pwsh` 一启动就报
`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\ai学习辅助工作流搭建)`。

原因：工作区目录上当前用户缺少 `WRITE_OWNER`，DSH 无法为沙箱子进程配置写入授权。

处置：用 DSH 的 ACL 诊断脚本一次性修复（备份与回滚脚本在 `D:\dsh-acl-recovery\`）。

回滚（如需）：

```
pwsh -NoProfile -File 'D:\dsh-acl-recovery\acl-backup-bd24995082644cfda3ef268f31a0f98f.json.ps1' -Path 'D:\ai学习辅助工作流搭建' -AllowRoot 'D:\ai学习辅助工作流搭建' -Restore 'D:\dsh-acl-recovery\acl-backup-bd24995082644cfda3ef268f31a0f98f.json'
```

### 坑 2 · 沙箱不允许管道式子进程

现象：`pnpm install` 在 postinstall 阶段报 `EPERM`；`prisma migrate` 报 `spawn EPERM`；
`node --test` 多文件模式也报 `spawn EPERM`。

原因：当前沙箱模式下子进程无法通过命名管道取输出，`child_process.spawn` 的默认
`stdio: 'pipe'` 会被拒；`stdio: 'inherit'` / `'ignore'` 不受影响。

处置：

- 依赖安装统一 `--ignore-scripts`（`pnpm-workspace.yaml` 已设 `verifyDepsBeforeRun: false`）
- Prisma 迁移/引擎类命令需要一次性放宽权限
- 单测直接 `node <file>.ts` 跑（同进程，不 spawn），不要用 `node --test <目录>`

### 坑 3 · pnpm 的 junction 让 Node 找不到模块

现象：`node node_modules/prisma/build/index.js` → `Cannot find module '@prisma/engines'`。

原因：本机 pnpm 生成的 junction 目标是 `Global\D:\...` 形式，Node 的 realpath / CJS 解析
从这里找不到包。

处置：`pnpm-workspace.yaml` 设 `nodeLinker: hoisted`。

### 坑 4 · `confbox` 子路径断裂

现象：`prisma` CLI 启动即
`ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './json' is not defined by "exports"`。

原因：`pkg-types@2.4.0` 的 dist 里 `import 'confbox/json'`，而它声明的 `confbox ^0.2` 没有该子路径。

处置：`pnpm-workspace.yaml` 里 `overrides.confbox: 0.3.2`。

### 坑 5 · Prisma CLI 的输出在管道下丢失

现象：包装脚本里 `await import()` 启动 prisma，命令跑成功了但一个字都不打印。

原因：CJS bundle 的 stdout 在管道上是异步的，进程先退出，输出丢失。

处置：`scripts/prisma.mjs` 改为子进程 + `stdio: 'inherit'`。

### 坑 6 · 工作区内不能删除文件

现象：`Remove-Item` 报"对路径的访问被拒绝"，但创建与修改都正常。

原因：工作区根目录有一条 `Everyone: DeleteSubdirectoriesAndFiles` 拒绝项，
这是 DSH 的预期配置，**不要手工删这条拒绝项**。

影响：构建产物（`.next`、`dist`）只能覆盖不能删除；清理请在资源管理器里手动做。

处置：根目录的 `.dsh-write-probe` 是早期探测写权限留下的 6 字节文件，同样受此限制删不掉，
已在 `.gitignore` 中忽略，手动删掉即可。

## 4. 常用命令（含 pnpm 的完整调用形式）

**`pnpm` 不在 PATH 上**（`command -v pnpm` 为空、无 `corepack`）。本机唯一可用形式：

```powershell
$PNPM = 'C:\Users\terry\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
node $PNPM --version        # → 11.28.5
node $PNPM install --ignore-scripts
```

除安装依赖外，所有数据库命令都**不经过 pnpm**，直接走仓库自带的包装脚本：

```bash
node scripts/prisma.mjs validate  --schema packages/db/prisma/schema.prisma
node scripts/prisma.mjs generate  --schema packages/db/prisma/schema.prisma
node scripts/prisma.mjs migrate dev --schema packages/db/prisma/schema.prisma
node scripts/prisma.mjs migrate deploy --schema packages/db/prisma/schema.prisma
node scripts/prisma.mjs migrate diff --from-empty --to-schema-datamodel packages/db/prisma/schema.prisma --script
```

两条零依赖校验：

```bash
node scripts/check-guards-sync.mjs   # guards.sql 与 guard migrations 的语句流是否一致
node scripts/check-drift.mjs         # 漂移防护：diff 里出现删手写索引就 exit 1
node scripts/verify-sql.mjs          # PGlite 快速回归（不是验收证据）
```

### 4.1 单测怎么跑（M1 起）

```bash
node packages/contracts/test/ports.test.ts                       # 端口矩阵 27 条
node apps/api/test/unit/dag.test.ts                              # DAG / 下游收集 13 条
node apps/api/test/integration/downstream-equivalence.test.ts    # 真库等价性 2 条（需容器）
```

三条硬规矩：

1. **直接跑文件，不要 `node --test <目录>`**：多文件模式会 spawn 子进程，沙箱下 EPERM（坑 2）。
2. **不要通过包名 import `@studygraph/contracts`**：Node 的类型剥离对 node_modules 内的文件直接报
   `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`（pnpm 的 workspace 链接会解析到 node_modules）。
   M1 阶段 `apps/api/src/domain/graph/dag.ts` 用相对路径直连 `packages/contracts/src/index.ts`；
   M2 引入 tsc 构建后改回包名。
3. 断言用 Node 内置的 `node:assert/strict`，不引入 vitest —— 保持"零新增依赖"，测试框架 M2 再定。

### 4.2 `migrate dev` 会删手写索引（已确认，必须防）

Prisma 无法从 `schema.prisma` 推出 `Concept_embedding_hnsw`（HNSW）与 `Concept_name_trgm`（gin_trgm_ops），
所以 `migrate diff` 会把它们当成多余索引并且生成：

```sql
DROP INDEX "Concept_embedding_hnsw";
DROP INDEX "Concept_name_trgm";
```

**规矩**：

- 日常应用迁移只用 `node scripts/prisma.mjs migrate deploy`
- `migrate dev`（`pnpm db:migrate:dev`）只在改 schema 时用，且**生成的 migration 必须人工检查**
- 出现上面两行 `DROP INDEX` 一律删掉再应用
- 提交前跑 `node scripts/check-drift.mjs`：检测到就 exit 1 并打印原因（已实测会拦）

## 5. 首次建库步骤（DB 就绪后按顺序做）

```bash
docker compose up -d postgres

# 三个 migration 一起应用：
#   20261118030000_init             表 / 枚举 / 外键 / 复合外键
#   20261118030100_guards           CHECK 7 / 触发器 6 / 视图 4 / 索引 2
#   20261119000000_edge_no_self_loop CHECK 1（禁止自环边）
node scripts/prisma.mjs migrate deploy --schema packages/db/prisma/schema.prisma

# 自检（PG16 实测：8 / 6 / 4，CHECK 由 7 变 8 是自环约束带来的）
psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_constraint WHERE contype='c' AND connamespace='public'::regnamespace;"
psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal;"
psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_views WHERE schemaname='public';"

# 审计视图应为空
psql "$DATABASE_URL" -c 'SELECT * FROM "v_verified_without_citation";'
psql "$DATABASE_URL" -c 'SELECT * FROM "v_method_concept_mismatch";'
```

`guards.sql` 不再需要手工执行——它已经是一个 migration。
`packages/db/sql/guards.sql` 只是给人读的同步副本，改它之前先改 migration。

## 6. 没有 Docker 时怎么验证 SQL

`scripts/verify-sql.mjs` 用 PGlite（PostgreSQL 编译到 WASM）把两个 migration 原样执行，
并跑四个负向/正向用例。它**不是项目依赖**，需要的时候装在仓库外：

```bash
mkdir %TEMP%\pgverify && cd %TEMP%\pgverify
npm i @electric-sql/pglite@0.3.14 --cache %TEMP%\npmcache
# 回到仓库
set PGLITE_DIR=%TEMP%\pgverify
node scripts/verify-sql.mjs
```

注意：PGlite 能证明 SQL 语义（含 pgvector 类型、触发器、视图、复合外键），
但**不能替代** `pgvector/pgvector:pg16` 容器上的最终验收。

## 7. 交付前的验证清单

| 检查 | 命令 | 预期 |
| --- | --- | --- |
| schema 语法 | `node scripts/prisma.mjs validate ...` | valid |
| DDL 可渲染 | `migrate diff ... --script` | 34 表 / 27 枚举 |
| guards 与 migration 一致 | `node scripts/check-guards-sync.mjs` | ✅ 同步 |
| SQL 不变量 | `node scripts/verify-sql.mjs` | 7 / 6 / 4 + 四个 ✅ |
| 端口矩阵契约 | `node packages/contracts/test/ports.test.ts` | 27 pass |
| DAG / 下游收集 | `node apps/api/test/unit/dag.test.ts` | 11 pass |
| 迁移与 schema 无漂移 | 建库后 `migrate diff --from-url ...` | 空 diff |

## 8. 本机装 Docker 的实操记录（2026-11-18）

机器是 **Windows 10 Home China**（Build 26300），无 Hyper-V，Docker Desktop 只能走 WSL2 后端。
网络直连被 `Scholar Root CA v1` / `Scholar Verify` 做 TLS 中间人，**所有下载必须经代理 `127.0.0.1:7897`**。

### 8.1 安装包（已下载并验证）

| 项 | 值 |
| --- | --- |
| 路径 | `D:\docker-installer\DockerDesktopInstaller.exe` |
| 大小 | 623,969,712 字节（与服务器 `content-length` 一致） |
| 版本 | 4.99.0.245822 |
| SHA256 | `A5E299131C9C53D60F3F752B162078945EB5FAF6EEDCF0BE20A214C6E6CEA444` |
| Authenticode | **Valid**，`CN=Docker Inc, O=Docker Inc`，DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1 |

下载方法（代理启用的前提下）：`node tmp/resume-docker.mjs`（HTTP/1.1 CONNECT + Range 续传；
直接 `fetch` 走 HTTP/2 会在 ~500 MiB 被中间设备重置流）。

### 8.2 安装顺序

```powershell
# 管理员：让 Windows 服务 / WSL / Windows Update 也走代理
netsh winhttp set proxy 127.0.0.1:7897

# 管理员：先装 WSL2 运行时（Home 版必需），然后重启
wsl --install --no-distribution

# 管理员：装 Docker Desktop（静默、接受许可、指定 WSL2 后端）
Start-Process -FilePath 'D:\docker-installer\DockerDesktopInstaller.exe' `
  -ArgumentList 'install','--quiet','--accept-license','--backend=wsl-2' `
  -Verb RunAs -Wait

# 装完撤销系统级代理（可选，winget 仍需要代理时保留）
netsh winhttp reset proxy
```

### 8.3 起来之后

```powershell
docker compose up -d postgres
node scripts/prisma.mjs migrate deploy --schema packages/db/prisma/schema.prisma
# 然后按 §5 的四条自检查询走
```
