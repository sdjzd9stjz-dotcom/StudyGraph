# 011 工程交付 · DeepSeek 实调阶段记录

本轮授权限本项目十份 PPTX 提取文字，总预算 60,000 输入、20,000 输出 token。已通过本机现有 API 执行两次真实的 ch3-2.pptx 抽取。该服务仍为 009 版本，产物缺少 010 新增的 quote 字段；两次均未继续写入概念卡。

| 调用 | 本地节点缓存 | 实际模型 | 输入 | 输出 | 厂商前缀命中 |
|---|---|---|---:|---:|---:|
| A1 | false | deepseek-flash | 1419 | 404 | 256 |
| A2 | false | deepseek-flash | 1419 | 382 | 1280 |

开始时间相距约 105 秒。D1 同前缀复测观察到第二次命中；两笔均有 UsageRecord，D3 得到核实。D2 更换 system 前缀尚未执行。已用 2,838 / 786，剩余 57,162 / 19,214。此记录不作 010 的独立验收判定。

## 工程 AI 本次交付

- 核对授权的十份课件（266 页）及 SHA-256 清单。
- 新增 [实调入口](../../scripts/run-011-deepseek.mjs)。预检命令 `node --env-file=.env scripts/run-011-deepseek.mjs --preflight` 已验证十个文件。运行时校验输入来源、唯一厂商地址，每次发送前预留预算，遇到异常即停止。
- 新增 [本机隐藏输入启动脚本](../../scripts/start-011-deepseek.ps1)。进程读取本机输入的密钥，不写入仓库；新版将另外验证 A/A/B 前缀和十份课件的 Source→CHUNK→EXTRACT→CARD，结果写入同目录的实调证据 JSONL。重复启动不会覆盖已有账本。上述新版流程仅完成离线预检，未计作实调成功。
- 聊天中出现的密钥未写入脚本或交付文件。建议轮换后从本机隐藏输入提示注入。若窗口已关闭，在项目根目录 PowerShell 执行 `.\scripts\start-011-deepseek.ps1`。

## 两笔真实用量的复查命令和输出

```powershell
node --env-file=.env --input-type=module -e "import {prisma as p} from './packages/db/src/index.ts';const ids=['cmwnmqqy9003hq5fwxcmozizx','cmwnmt06c003qq5fw5kmbzetb'];for(const id of ids){const r=await p.run.findUniqueOrThrow({where:{id}});const u=await p.usageRecord.findFirstOrThrow({where:{runId:id}});console.log(id,r.cacheHit,u.provider,u.model,u.tokensIn,u.tokensOut,u.cachedTokens,r.startedAt.toISOString())}"
```

```text
cmwnmqqy9003hq5fwxcmozizx false deepseek deepseek-flash 1419 404 256 2026-11-19T14:12:46.448Z
cmwnmt06c003qq5fw5kmbzetb false deepseek deepseek-flash 1419 382 1280 2026-11-19T14:14:31.716Z
```
