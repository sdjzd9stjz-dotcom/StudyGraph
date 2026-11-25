# 给 GPT 的任务指令：修复 StudyGraph 画布的「组折叠记忆」与「退出全量保存」

> **使用方法**：把本文件整份贴给 GPT。它自包含，读完即可开工。
> **工作区**：`D:\ai学习辅助工作流搭建`
> **技术栈**：Next.js 14 App Router（`output: 'standalone'`）+ Fastify + Prisma 6 + PostgreSQL 16 + Electron 33
> **画布库**：`@xyflow/react@12.12.1`
> **当前提交**：`ecfe48b`（分支 `feat/desktop-m5-m6`）

---

## 0. 你的任务（按优先级）

1. **组重进画布后不要自动折叠**，而且要**记住每个组的展开位置**（成员相对位置）
2. **修复展开态虚线框框不住成员**的显示问题（见下方截图描述）
3. **离开画布时保存全部内容**：节点坐标、组状态、底部 AI 对话上下文、每个节点的对话上下文
4. **确认保存完成后再退出**，并**弹出进度弹窗**让用户看得见

**纪律**：这个项目被打回过多次，原因全是「声称完成但其实没验证」。
每条"已修复"必须给出可粘贴的终端输出或明确说明"未实机验证 + 原因"。
**不要用加开关、加重试、加兜底弹窗的方式掩盖问题。**

---

## 1. 用户报的三个现象（原话）

### 现象 A：组自动折叠 + 展开位置错乱

> 「每次退出重进会自动折叠组，并且展开时会出现这个问题，请修复，
> 让它每次重进的时候需要有保持对于每个组的相对位置的记忆，不要再出现这种情况了」

截图里能看到：
- 组是**展开态**（彩色虚线框），框的左上角有自己的标题条
- 但**框框不住成员**：成员的卡片明显溢出了虚线框的右边界，
  并且有两张卡叠在框的左上角区域，把组标题条压住了
- 这说明展开时成员的坐标和框的坐标**不在同一个参照系**里

### 现象 B：对话上下文在退出后全部丢失

> 「每个节点里的对话的上下文，这些东西都在退出后遗失了」

具体有两份：
1. **底部 AI 对话**（`AssistantBar`，`studygraph:assistant:<canvasId>`）
2. **每个节点自己的对话**（`NodeChat`，`studygraph:node-chat:<nodeId>`）

这两份目前都存在 **`sessionStorage`**，关掉窗口就没了。

### 现象 C：需要可见的保存过程

> 「直到确认已经完全保存了之后再退出，保存时可以弹出弹窗来显示保存进度，
> 以增加用户的交互感」

---

## 2. 已经诊断出的代码事实（别重复挖，直接用）

### 2.1 组为什么会自动折叠

```
packages/db/prisma/schema.prisma   → NodeGroup.collapsed Boolean @default(false)
apps/web/components/canvas/CanvasWorkbench.tsx
  · const [collapsed, setCollapsed] = useState(...) 从 initialGroups 里读 collapsed
  · toggleGroup() 每次开合都 PATCH /v1/groups/:id { collapsed: true|false }
```

`0.25.1` 起，开合状态已经**写进数据库**了。所以"重进自动折叠"要么是：
- 数据库里那条 `collapsed` 真的是 `true`（之前某个版本在用户没注意时写进去的）；
- 要么是 `initialGroups` 没把 `collapsed` 传下来（服务端 select 漏了字段）；
- 要么是 `saveAll` / 卸载时的保存把 `collapsed` 覆盖回去了。

**用户的实际期望更强**：不止是"别自动折叠"，而是**每个组在展开态下的成员相对位置要被记住**。

### 2.2 组的位置模型（关键，别改错）

```
锚点：group.posX / posY  =  折叠卡片所在的绝对画布坐标
                         =  展开后虚线框的左上角
成员：每个 node 的 position 是绝对画布坐标
框尺寸：由成员相对锚点的包围盒算出（apps/web/lib/group-motion.ts 的 frameBox）
```

`frameBox(members)` 会返回 `{ width, height, dx, dy }`：
成员跑到锚点左上方时，`dx/dy` 为负，框整体平移过去。
`CanvasWorkbench` 里组节点的 `position` 已经是 `anchor + (dx, dy)`。

**收起时**：成员在本地被移动到堆叠点（`stackTargets`），并**不写库**；
快照存在内存 `memberOrigins.current`，重进画布就没了。
**展开时**：`restoreTargets(saved, memberIds, anchor, current)` 优先用内存快照，
其次用成员当前坐标，最后才是网格排布。

**这就是现象 A 的可能来源**：如果重进后成员坐标已经被写过一次（比如拖过组），
"当前坐标"就不等于收起前的相对位置了。

### 2.3 现有的"退出保存"只保存了坐标

`apps/web/components/canvas/CanvasWorkbench.tsx` 里的 `saveAll(reason)`：

- 只对比并 PATCH **节点的 posX/posY** 与 **组的 posX/posY**
- 触发点：`pagehide`、`beforeunload`、组件卸载
- 有一个 `savedPositions` ref 记录"上次已保存的值"
- 右上角有一个 `savePhase` 提示（`saving` / `saved` / `error`），带转圈

**它不保存**：`collapsed`、对话历史、节点参数、任何 `params` 改动。

两个容易忽略的细节：

1. `saveAll` 里**过滤掉了**「正在播放开合动画的组」的成员，以及被收起的组内成员
   （`hiddenNodeIds`）—— 这是对的（它们的坐标在动画中途是假的），
   但也意味着**收起状态下退出，成员的真实坐标完全不会被写**。
2. `collapsed` 只在 `toggleGroup()` 里写，`saveAll` **从不写它**。
   所以"重进自动折叠"更可能是：某个时刻数据库里那条记录变成了 `true`
   （比如动画中途退出、或 PATCH 失败后没回滚），
   而不是退出保存顺序的问题 —— 请先查实际数据再下结论。

具体的过滤器（`CanvasWorkbench.tsx` 约 1582 行）：

```ts
const nodeChanges = changedPositions(
  nodes.filter(node => !hiddenNodeIds.has(node.id) &&
    !groups.find(g => g.id === animating?.groupId)?.memberIds.includes(node.id))
    .map(node => ({ id: node.id, x: node.position.x, y: node.position.y })),
  savedPositions.current,
).filter(item => !isGroupNodeId(item.id))
```

### 2.4 两份对话现在存在哪里

| 位置 | 键 | 文件 |
| --- | --- | --- |
| 底部 AI 对话 | `studygraph:assistant:<canvasId>` | `apps/web/components/canvas/AssistantBar.tsx`（`THREAD_PREFIX`） |
| 节点对话 | `studygraph:node-chat:<nodeId>` | `apps/web/components/canvas/NodeChat.tsx`（`KEY_PREFIX`） |

两边都是 `sessionStorage`，只保留最近 40 / 30 条。
`NodeChat` 还会尝试 `GET /v1/nodes/:nodeId/messages` 读服务端记录（有这个接口）。

**`Node` 表目前没有对话字段**，需要你决定是加列还是新建表。

---

## 3. 要求一：组的展开位置要有持久记忆

### 3.1 期望行为

- 退出再进画布，**组保持你离开时的开合状态**
- 展开态下，**每个成员回到它在这一组里的相对位置**（不是网格重排、不是叠在一起）
- 拖动过组之后，相对位置也不丢

### 3.2 建议的实现方向（可以推翻，但要说明理由）

**核心问题**：现在"成员相对位置"只活在内存快照里。

建议把它**落库**，两种方案选一种：

**方案 A（推荐）：组记住自己的"展开矩形"**
```
NodeGroup 增加：展开态的锚点/尺寸，或者直接存 memberPositions Json
  memberPositions: { [nodeId]: { x, y } }   // 收起那一刻的快照，绝对坐标
```
- 收起时：把成员当前坐标写进 `NodeGroupMember.offsetX/offsetY`（相对锚点）
- 展开时：优先读它，其次读节点当前坐标
- 好处：即使节点坐标被别的操作改过，组内相对位置依然稳定

**方案 B：给 `NodeGroupMember` 加 `offsetX/offsetY`**
- 收起时写一次，展开时读
- 同样能解决"重进后相对位置丢失"

两种都要注意：**拖动整个组时，成员的绝对坐标会变、但相对偏移不变**，
所以 `offsetX/offsetY` 在拖组时**不需要改**（这正是方案 A/B 优于存绝对坐标的地方）。

### 3.3 顺带要修的：虚线框框不住成员

检查 `group-motion.ts` 的 `frameBox`：

- `nodeWidth` / `nodeHeight` 现在**写死 320 / 220**，
  但真实节点宽度是**按内容变化的**（说明书写的是 232 / 276 / 320，最大 420）
- 成员宽度超过 320 时，`right = max(x + 320)` 就算小了 → 框一定包不住
- **修法**：把每个节点的**真实测量尺寸**传给 `frameBox`，
  数据从 React Flow 的 `measured`（`onNodesChange` 里已有写回逻辑）取

另外检查左上角标题条（`topInset: 34`）：
成员如果被拖到锚点正下方，会和标题条重叠 —— 需要把 `topInset` 也算进最小高度。

---

## 4. 要求二：退出时保存全部内容

### 4.1 必须保存的清单

| 内容 | 现在 | 要变成 |
| --- | --- | --- |
| 节点坐标 | ✅ PATCH | 保持 |
| 组坐标 | ✅ PATCH | 保持 |
| **组的开合状态** | ❌ | 存库（已有字段，确保退出前写一次） |
| **组内相对位置** | ❌ | 见 §3 |
| **底部 AI 对话** | sessionStorage | **落库**（退出后还能看到） |
| **节点对话** | sessionStorage | **落库** |
| 节点 `params` | 各操作即时写 | 退出时不必重复；但**未提交的编辑框内容**要一起提交 |

### 4.2 对话落库的两种做法

**A. 新增表（干净）**
```prisma
model ChatThread {
  id        String   @id @default(cuid())
  canvasId  String
  /// null = 底部 AI 对话；非 null = 某个节点的对话
  nodeId    String?
  ownerId   String
  messages  Json     @default("[]")
  updatedAt DateTime @updatedAt
  @@unique([canvasId, nodeId])
}
```

**B. 塞进 `Node.params` / `Canvas.meta`（快，但脏）**
不推荐：`params` 有 zod schema 校验，塞对话会污染执行指纹（`fingerprint`）。

**注意**：`Node.fingerprint` 是 `sha256(上游 artifacts + params + modelVersion + promptVersion)`。
如果把对话塞进 `params`，会让每次聊天都改变指纹 → 所有下游被判 STALE。
**所以对话必须存在 `params` 之外。**

### 4.3 保存进度弹窗

用户明确要"弹窗显示保存进度，增加交互感"。

要求：
- 点「← 返回」或关窗口时**先弹窗**，列出要保存的项和进度（例如"节点坐标 3/12"）
- **全部成功后才跳转/关闭**；有关键项失败时**拦住退出**并说明原因
  （用户可以选"仍然退出"）
- 纯展示的进度条即可，不需要百分比动画的复杂度

**技术要点**：
- 关闭窗口时浏览器不允许 async 拦截，`beforeunload` 只能返回字符串。
  所以桌面版应该走 **Electron 的 `before-quit` / `close` 事件**（`apps/desktop/main.cjs`），
  由主进程询问渲染进程"保存完了吗"，没完就取消这次关闭。
- 浏览器里（开发时）降级为：`pagehide` 时用 `fetch(..., { keepalive: true })` 兜底。

---

## 5. 已知的环境限制（很可能影响你验证）

**这台机器上 PostgreSQL 起不来**：

- `resources/pgsql/bin/initdb.exe` 在纯 ASCII 路径（`C:\Users\terry\sgdev`）也报
  `could not create directory ... Permission denied`
- `pg_ctl start` 报 `could not create lock file "postmaster.pid": Permission denied`
- 同一个 shell 里 `mkdir` / `icacls` 都正常，怀疑是杀软拦截

**所以**：如果改动涉及画布交互，**请不要声称"已验证"**。
至少要说清：改了什么、为什么这样改、没验证的部分是什么。

如果能起服务，验证路径是：
```bash
# API（需要可用的 PostgreSQL）
cd apps/api && node src/server.ts
# web
cd apps/web && npx next dev -p 3000
```

---

## 6. 约束与约定（照做）

1. **中文界面 + 中文注释**；注释写「为什么」，不写「是什么」
2. **改功能必须同步**：
   - `docs/使用说明书.md`（应用内「使用教程」页读它）
   - `docs/人工验收清单.md`
3. **两边单测必须过**：
   ```bash
   cd apps/web && npm run test:unit     # 当前 32 项
   cd apps/api && npm run test:unit     # 当前 62 项
   npx tsc -p apps/web/tsconfig.json --noEmit
   npx tsc -p apps/api/tsconfig.json --noEmit
   ```
4. **打包**：`node scripts/build-desktop.mjs` → 再用 Inno Setup 编译
   （`C:\Users\terry\AppData\Local\Programs\Inno Setup 6\ISCC.exe`，
   必须 `MSYS_NO_PATHCONV=1` 且用 `/DSourceDir=` `/DAppVersion=` 传参）
5. **不要碰**：`StudyGraph-Agent-Prompt.md`（只读规格）、`提示词附件-中文译文.txt`（用户的文件）

---

## 7. 关键文件地图

| 文件 | 作用 |
| --- | --- |
| `apps/web/components/canvas/CanvasWorkbench.tsx` | 画布主组件（~2200 行），组、连线、保存全在这 |
| `apps/web/components/canvas/SgGroupNode.tsx` | 组的两种形态与两个端口 |
| `apps/web/components/canvas/connect-draft.tsx` | 拖线高亮 context |
| `apps/web/lib/group-motion.ts` | 开合动画、`frameBox`、`restoreTargets` |
| `apps/web/lib/save-state.ts` | 退出保存的差异计算与文案 |
| `apps/web/components/canvas/AssistantBar.tsx` | 底部 AI 对话（sessionStorage） |
| `apps/web/components/canvas/NodeChat.tsx` | 节点对话（sessionStorage） |
| `apps/api/src/routes/groups.ts` | 组 CRUD、成员、link |
| `packages/db/prisma/schema.prisma` | `NodeGroup` / `NodeGroupMember` / `Node` |
| `docs/交接-2026-11-24-组与画布.md` | 更完整的项目背景（建议一起读） |

---

## 8. 交付时请回答

1. 「重进后组不折叠」的根因是什么？改的是哪一行？
2. 组内相对位置现在存在哪里？拖组之后为什么不丢？
3. 虚线框为什么框不住成员？`frameBox` 现在拿到的尺寸是真实尺寸吗？
4. 两份对话现在落在哪张表、哪个接口？退出后重进还能看到吗？
5. 保存弹窗在"关窗口"这一路径上怎么保证完成？（浏览器做不到的部分说明清楚）
6. 哪些项你在真实画布上验证过，哪些没有？没验证的原因是什么？
