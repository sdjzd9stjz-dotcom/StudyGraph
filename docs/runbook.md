# 运行手册

> 记录「这台机器上怎么跑起来」以及踩过的坑。换机器时上一节看环境要求，后面几节基本都是 Windows 相关。

## 1. 环境要求

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | ≥ 22.11 | 本机 26.13.1 |
| pnpm | 11.x | 本机 11.28.5（`packageManager` 已锁定） |
| PostgreSQL | 16 + pgvector 扩展 | `Concept.embedding vector(1536)`、递归 CTE |
| Redis | 7+ | BullMQ 队列、SSE 事件广播、OAuth 授权码 |
| S3 兼容存储 | MinIO 即可 | 原文、切片、大产物 |

## 2. 本机现状（2026-11-18）

已安装：Node 26.13.1、pnpm 11.28.5、git 2.56.1。

**缺失：Docker、PostgreSQL、Redis、MinIO。** 因此：

- `pnpm db:migrate` 无法执行（需要 `DATABASE_URL` 指向真实实例）
- M2 的队列链路无法端到端验证
- `guards.sql` 尚未在任何实例上执行过

`docker-compose.yml` 已经写好，装上 Docker Desktop 后 `docker compose up -d` 即可得到
PostgreSQL 16 + pgvector、Redis 7、MinIO。**这是待用户决策的阻塞项。**

## 3. 这台机器上已经踩过的坑

### 坑 1 · 工作区文件夹权限导致 shell 写不进去

现象：读写文件的工具正常，但 `pwsh` 一启动就报
`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\ai学习辅助工作流搭建)`。

原因：工作区目录上当前用户缺少 `WRITE_OWNER`，DSH 无法为沙箱子进程配置写入授权。

处置：用 DSH 的 ACL 诊断脚本一次性修复（备份与回滚脚本在 `D:\dsh-acl-recovery\`）。
修复后 `writeOwner` 由 false 变 true，shell 恢复正常。

回滚（如需）：

```
pwsh -NoProfile -File 'D:\dsh-acl-recovery\acl-backup-bd24995082644cfda3ef268f31a0f98f.json.ps1' -Path 'D:\ai学习辅助工作流搭建' -AllowRoot 'D:\ai学习辅助工作流搭建' -Restore 'D:\dsh-acl-recovery\acl-backup-bd24995082644cfda3ef268f31a0f98f.json'
```

### 坑 2 · 沙箱不允许管道式子进程

现象：`pnpm install` 在 postinstall 阶段报 `EPERM`；`prisma migrate` 报 `spawn EPERM`。

原因：当前沙箱模式下子进程无法通过命名管道取输出，`child_process.spawn` 的默认
`stdio: 'pipe'` 会被拒。`stdio: 'inherit'` / `'ignore'` 不受影响。

处置：

- 依赖安装统一用 `pnpm install --ignore-scripts`（`pnpm-workspace.yaml` 里已设
  `verifyDepsBeforeRun: false`，避免每次跑脚本前又触发一次安装）
- Prisma 的迁移/引擎类命令需要一次性放宽权限执行（`prisma validate` / `generate`
  走 WASM，不受影响）

### 坑 3 · pnpm 的 junction 让 Node 找不到模块

现象：`node node_modules/prisma/build/index.js` → `Cannot find module '@prisma/engines'`。

原因：本机 pnpm 生成的 junction 目标是 `Global\D:\...` 形式，Node 的 realpath / CJS 解析
从这里找不到包。

处置：`pnpm-workspace.yaml` 设 `nodeLinker: hoisted`（与 npm 布局一致，无 junction）。
代价是可能出现幽灵依赖，由 tsc / eslint 兜住。

### 坑 4 · `confbox` 子路径断裂

现象：`prisma` CLI 启动即
`ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './json' is not defined by "exports" in confbox/package.json`。

原因：`pkg-types@2.4.0` 的 dist 里 `import 'confbox/json'`，而它自己声明的 `confbox ^0.2` 没有该子路径
（`./json` 是 0.3.x 才有的）。

处置：`pnpm-workspace.yaml` 里 `overrides.confbox: 0.3.2`。

### 坑 5 · Prisma CLI 的输出在管道下丢失

现象：包装脚本里 `await import()` 启动 prisma，命令跑成功了但一个字都不打印。

原因：CJS bundle 的 stdout 在管道上是异步的，进程先退出，输出丢失。

处置：`scripts/prisma.mjs` 改为子进程 + `stdio: 'inherit'`。

### 坑 6 · 工作区内不能删除文件

现象：`Remove-Item` 报"对路径的访问被拒绝"，但创建与修改都正常。

原因：工作区根目录上有一条 `Everyone: DeleteSubdirectoriesAndFiles` 的拒绝项，
这是 DSH 的预期配置（防止沙箱内进程清空工作区），不是权限损坏，**不要手工删这条拒绝项**。

影响：构建产物（`.next`、`dist`）只能覆盖不能删除；需要清理时在资源管理器里手动删，
或让构建工具写到工作区外的临时目录。

处置：根目录的 `.dsh-write-probe` 是早期探测写权限留下的 6 字节文件，同样受此限制删不掉，
在资源管理器里手动删掉即可。

## 4. 常用命令

```bash
# 安装依赖（本机必须带 --ignore-scripts，原因见坑 2）
pnpm install --ignore-scripts

# 校验 / 格式化 / 生成 Client（无需数据库）
pnpm db:validate
pnpm db:format
pnpm db:generate

# 查看"schema 会建出什么表"（不连库，需放宽权限）
pnpm db:ddl

# 有数据库之后
pnpm db:migrate        # 应用迁移
pnpm db:studio         # 浏览数据
```

## 5. 首次建库步骤（DB 就绪后按顺序做）

```bash
# 1. 起依赖服务
docker compose up -d

# 2. 应用迁移（生成本仓库 20261118030000_init）
pnpm db:migrate

# 3. 执行物理约束（CHECK / 触发器 / 审计视图）
#    注意：这一步尚未在任何实例上验证过，跑完把结果记进 docs/milestone-1.md
psql "$DATABASE_URL" -f packages/db/sql/guards.sql

# 4. 自检：审计视图应全为空
psql "$DATABASE_URL" -c 'SELECT * FROM "v_verified_without_citation" LIMIT 5;'
psql "$DATABASE_URL" -c 'SELECT * FROM "v_problem_distractor_without_error_tag" LIMIT 5;'
```

## 6. 交付前的验证清单

| 检查 | 命令 |
| --- | --- |
| schema 语法 | `pnpm db:validate` |
| Client 可生成 | `pnpm db:generate` |
| DDL 可渲染 | `pnpm db:ddl` |
| 迁移与 schema 无漂移 | `pnpm db:migrate` 后再跑一次 `prisma migrate diff --from-url ... --to-schema-datamodel ...` |
| 物理约束生效 | 插入一条 `status='VERIFIED'` 且无引用的 Concept，应被触发器拒绝 |
