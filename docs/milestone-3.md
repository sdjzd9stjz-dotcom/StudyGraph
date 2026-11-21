# M3 · 知识视图 —— 验收记录

> 2026-11-21。本文只写**已跑通并留下终端原文**的行为。
> 规格 M3 清单：`prereq` 节点 / 图投影 / 掌握度热力 / `review` FSRS 调度 / 今日到期页。

---

## 1. 做了什么

| 项 | 落点 | 状态 |
| --- | --- | --- |
| FSRS-4.5 排程器 | `apps/api/src/domain/fsrs.ts` | ✅ 9 条单测 |
| 复习记账表 | `ReviewLog` + migration `20261121010000_review_log` | ✅ |
| 评分接口 | `POST /v1/concepts/:id/grade` | ✅ |
| 今日到期 | `GET /v1/reviews/due` | ✅ |
| 到期统计 | `GET /v1/reviews/stats` | ✅ |
| 知识投影 | `GET /v1/canvases/:id/graph?view=knowledge` | ✅ |
| 掌握度热力 | 画布页 `mastery-heat` 区块 | ✅ |
| 今日到期页 | `apps/web/app/review/page.tsx` | ✅ |
| `prereq` 执行器 | `apps/api/src/nodes/executors/prereq.ts` | ✅ 代码就位，**未实调**（见 §5） |

---

## 2. FSRS 为什么自己实现

「答对加一天、答错重置」那套（SM-2）已经过时。FSRS 用**可提取性 R** 决定间隔：

```
R(t,S) = (1 + 19/81 · t/S)^(-0.5)         t 天后还记得的概率
I(R,S) = (S / (19/81)) · (R^(-2) - 1)     达到目标保留率所需的间隔
```

参数取官方 FSRS-4.5 默认 19 个权重。以后可以按 `ReviewLog` 拟合，现在先跑通。

两条性质是这套算法能不能用的底线，单测直接盯住：

```
✔ 连续 GOOD：间隔必须单调不降（否则学生会觉得软件在反复打断）
✔ AGAIN 必须把卡打回复习中，并把稳定性压回去
✔ 同一天内狂点 GOOD 不会把间隔刷上天（短时公式）
✔ 掌握度：刚复习完接近 1，久了自然衰减
✔ 稳定性有上界，不会溢出成 Infinity
ℹ tests 9  ℹ pass 9  ℹ fail 0
```

「同一天狂点」那条不是凑数：没有短时公式，学生在十分钟内点六次 GOOD
能把间隔刷到几个月，之后这张卡就再也不出现了。

### 掌握度的定义

`mastery = 此刻的可提取性`，不是"上次复习时的快照"。
热力图要回答「现在还记得多少」，否则半年没复习的卡看着还是满分。

---

## 3. 端到端实测

真机（桌面版内置库），三张概念卡，先评 GOOD 再评 AGAIN：

```
到期数量: 3 | 全是新卡: true
评分: {"state":"REVIEW","days":3.13,"mastery":1}
再评 AGAIN: {"state":"RELEARNING","days":1.59}
评分后到期数量: 2 | 该卡还在: false
统计: {"dueCount":0,"newCount":2,"reviewedToday":2}
知识视图: {"nodes":3,"edges":0,"byMastery":{"new":2,"weak":0,"okay":0,"strong":1},"masteryOfGraded":[1]}
无 token 到期接口: 401
```

逐条说明这些数字证明了什么：

| 观察 | 证明了 |
| --- | --- |
| `days: 3.13` | 新卡评 GOOD 的初始稳定性 = `w[2] = 3.1262`，间隔按公式反推出来 |
| `AGAIN → RELEARNING, 1.59 天` | 答错不是"重置成新卡"，而是按遗忘曲线回落 |
| 评完 `该卡还在: false` | `dueAt` 真的被推到了未来，不是只写了个状态 |
| `byMastery.strong: 1` | 刚评完的卡 R≈1，落入 strong 桶 |
| `无 token: 401` | 复习接口没有裸奔 |

界面截图：`.tmp-backup/m3-review.png`（今日到期页，四档评分按钮）。

---

## 4. 途中被数据库守卫拦住三次（说明它真的在管用）

造测试数据时连续撞上：

1. `Concept cannot be VERIFIED without at least one source span citation`
2. `Concept cannot be PENDING_REVIEW without at least one source span citation`
3. `invalid input value for enum "SpanRegion": "BODY"`（实际只有 PAGE/SLIDE/NOTES）

前两条是迁移里的守卫触发器在拦「没有出处的概念变成可信状态」——
正是五条硬约束里「溯源是物理约束」那一条。测试数据只能老老实实造
`Node → Source → Span → ConceptCitation` 整条链才能立起来。

顺带修了一个自己的坑：`psql` **不加 `-v ON_ERROR_STOP=1` 时，INSERT 失败也返回 0**。
第一次造数据"成功"了但库里是空的，浪费了一轮排查。

---

## 5. 未完成 / 未验证

- **`prereq` 执行器没有实调**。代码写完了（提议先修边、强制 `PROPOSED`、
  拒绝自环与成环、证据取 from 概念自己的主引用），但当前环境没有可用的模型密钥，
  端到端跑不出真实提议。**按 §8 纪律，这不叫"已完成"**，只标注"代码就位、未实调"。
  接上密钥后需要验证：提议出来的边是 PROPOSED、带 spanId、不成环。
- `QUIZ` / `GRADE` / `REVIEW` 三个节点执行器仍在 `PLANNED_PLAN` 里。
  规格 M3 只要求「review FSRS 调度」，已由路由实现；这三个节点本身属于后续。
- 复习页没有做"键盘快捷键"和"错题本"入口。
- 掌握度热力只显示前 40 个概念，没有做分页。

---

## 6. 本轮新增的验证资产

```bash
# FSRS 算法（9 条断言，含单调性、上界、短时公式）
node --experimental-strip-types apps/api/test/unit/fsrs.test.ts

# 端到端（需要先起客户端）
node --experimental-strip-types tmp/e2e-m3.mjs <canvasId>
```
