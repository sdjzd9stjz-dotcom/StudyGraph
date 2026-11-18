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
node scripts/check-guards-sync.mjs   # guards.sql 与 guards migration 是否逐字节一致
node scripts/verify-sql.mjs          # 用 PGlite(PG17 WASM) 跑两个 migration + 负向用例
```

## 5. 首次建库步骤（DB 就绪后按顺序做）

```bash
docker compose up -d postgres

# 两个 migration 一起应用：20261118030000_init（表/枚举/外键）+ 20261118030100_guards（CHECK/触发器/视图）
node scripts/prisma.mjs migrate deploy --schema packages/db/prisma/schema.prisma

# 自检（预期 7 / 6 / 4）
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
| 迁移与 schema 无漂移 | 建库后 `migrate diff --from-url ...` | 空 diff |
