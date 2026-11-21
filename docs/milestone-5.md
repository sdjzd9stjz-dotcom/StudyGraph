# M5 · 解题方法 —— 验收记录

> 2026-11-21。规格 M5：`probe` / `method` / `solve` / `diagnose`、method 视图、
> 双熟练度模型、错题看板。
>
> **重要前提**：本机没有可用的模型密钥。四个执行器全部依赖模型调用，
> 所以本文严格区分「代码与注册已验证」与「模型行为未验证」。

---

## 1. 交付

| 项 | 落点 | 状态 |
| --- | --- | --- |
| `probe` 题型与考点识别 | `apps/api/src/nodes/executors/probe.ts` | ⚠️ 已注册，未实调 |
| `method` 解法抽取 | `.../method.ts` | ⚠️ 已注册，未实调 |
| `solve` 分步解法 | `.../solve.ts` | ⚠️ 已注册，未实调 |
| `diagnose` 错因归因 | `.../diagnose.ts` | ⚠️ 已注册，未实调 |
| method 视图投影 | `GET /v1/canvases/:id/graph?view=method` | ✅ 实测 |
| 错题看板 | `GET /v1/analytics/error-tags` + `/catalog` | ✅ 实测（空数据） |
| 双熟练度模型 | `Concept.mastery`（记忆）× `Method.proficiency`（解题） | ✅ 结构就位 |
| `Method.falterAt` | migration `20261121030000_method_falter_at` | ✅ |
| 错因词典种子 | migration `20261121030100_error_tag_seed` | ✅ 6 条 |

---

## 2. 已实测的部分

### 执行器注册（真机自检日志）

```
implemented: ["SOURCE","CHUNK","EXTRACT","CARD","PREREQ","PROBE","METHOD","SOLVE","DIAGNOSE"]
planned: 8   unionSize: 17
```

9 个已实现 + 8 个计划 = 17 个节点类型，没有遗漏也没有重复。

### method 视图与错题看板

```
1) method 视图: method | 方法数: 0 | 统计: {"methodCount":0,"byProficiency":{"untried":0,...},"conceptReadyButMethodUnproven":0}
2) 错因分布: {"attempts":0,"wrong":0,"untagged":0,"dist":[]}
2) 错因词典条数: 6
3) pipeline 视图: 200
4) 无 token: 401
```

错因词典从空表补到 6 条（六个 `ErrorCategory` 各一条）——
没有它，看板的下拉框和 diagnose 的 code 归属都会出现无法解释的项。

---

## 3. 双熟练度模型：两个变量不是一回事

规格要求「`mastery`（记忆）与 `proficiency`（解题）是两套状态变量」。

- **`Concept.mastery`**：FSRS 排程派生，衡量"这个概念你还记不记得"
- **`Method.proficiency`**：从 `MethodApplication` 派生，衡量"这类题你会不会做"

两者可以背离：概念背得滚瓜烂熟，遇到题还是想不到用——这正是学生最常见的卡点。
所以 method 视图里专门算了一个 `conceptReadyButMethodUnproven`：
「核心概念掌握度已过 0.6，但方法还没成功用过」的配对数。

**实现取舍**：`proficiency` 不手填，也不加 `reps/successes/lapses` 列，
而是每次查视图时从 `MethodApplication` 现算（`groupBy` 一次聚合）。
理由与仓库里已有的注释一致：*proficiency 是这张表的派生量，不是手填字段*。

---

## 4. 四个执行器的设计要点（代码已写，行为未验证）

| 执行器 | 关键约束 | 怎么落地的 |
| --- | --- | --- |
| `probe` | 输出隐含条件与易漏条件 | schema 强制 `hiddenConditions` / `easilyMissed` 两个数组 |
| `method` | **conditions 不许为空** | 返回里 `conditions` 为空直接抛错——只讲"什么时候用"不讲"什么时候不能用"的方法是有害的 |
| `method` | 只连已有概念 | 概念名 → id 的映射只查本画布，查不到就不连，**不凭空造概念** |
| `solve` | **不可跳步** | 每步强制 `cue` + `why`；跑完扫一遍 `由上式可得/显然/易得/整理得/综上可得`，命中就进 `skipWarnings` |
| `diagnose` | 错因必须回连步骤 | schema 强制 `stepIndex` + `patch`，只说"计算错误"没有教学价值 |
| `diagnose` | 未知 code 不入库 | 过滤掉不在 `ErrorCategory` 里的 code，并作为 `droppedCodes` 返回 |

`solve` 的跳步检测是**告警不是阻断**：可能是合理省略，必须让人看见，但不能替人否决。

---

## 5. 未完成 / 未验证（按 §8 纪律，一律不写成已完成）

- **四个执行器的模型行为全部未验证**。没有密钥，跑不出真实输出。
  尤其未验证的是：
  - `probe` 的「易漏条件」是否真的抓到了学生会漏的条件
  - `method` 的 `conditions` 是否有实质内容（不是"条件不满足时不能用"这种同义反复）
  - `solve` 是否真的不跳步（跳步检测只查关键词，查不出"话都说了但逻辑跳了"）
  - `diagnose` 的 `stepIndex` 定位准不准
- **method 视图与错题看板的界面未做**，只有 API。
- 错题看板的"按概念/方法下钻"未做。
- `Method.proficiency` 的**更新逻辑未写**：目前没有任何代码在作答后回写 proficiency，
  只建了"从 MethodApplication 派生"的读取路径。这是个真实缺口，
  等 `GRADE` 节点（M3 计划里、仍未实现）落地后才有触发点。
- `Problem` / `Attempt` 的写入路径（出题、作答）属于 M6，本轮未做，
  所以看板天然是空的。

---

## 6. 验证脚本

```bash
node --experimental-strip-types tmp/e2e-m5.mjs
```
