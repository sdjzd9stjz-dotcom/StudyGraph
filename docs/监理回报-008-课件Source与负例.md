# M2 主体回报 · 第 4–6 项（课件 Source / 空页 / 扫描件负例）

> 对应 **SG-SUP-007 §9 待办清单**的第 4、5、6 项。
> 版本：本轮提交。全部输出为本机真实执行结果。

---

## 结论先行

| # | 事项 | 状态 |
| --- | --- | --- |
| 4 | 建立 10 个 `Source`，核对幻灯片数与字符数 | ✅ 10 个 Source，`pageCount` 合计 **266**，与计数脚本完全一致 |
| 5 | 空文本页统计 | ✅ **46 页**空文本，与计数脚本一致；这些页**没有产生任何 span** |
| 6 | 扫描 PDF 负例用例 | ✅ **422 `SOURCE_HAS_NO_TEXT_LAYER`**，0 Source、0 Span、0 Card |
| 7 | 四节点跑通 + 卡片产出 | ⬜ `source`/`chunk` 已通；`extract`/`card` 仍缺模型 key |

---

## 1 · 本轮新增的实现

| 文件 | 作用 |
| --- | --- |
| `packages/db/prisma/migrations/20261120000000_span_region/` | `Span.region`（PAGE/SLIDE/NOTES）+ 唯一键加入 region |
| `apps/api/src/storage/pptx.ts` | PPTX 抽取：`<a:t>`，含表格；母版/版式排除；备注页单独 region |
| `apps/api/src/storage/pdf.ts` | PDF 抽取（unpdf），逐页纯文本 |
| `apps/api/src/storage/extract-text.ts` | 按扩展名分派 + sha256 + 字符统计 |
| `apps/api/src/storage/page-text.ts` | `text.json` 的 S3 读写约定 |
| `apps/api/src/nodes/executors/source.ts` | **source 执行器**：落 Source/Span、上传原文与页文本 |
| `apps/api/src/nodes/executors/chunk.ts` | **chunk 执行器**：一页一片，`spanIds` 指向该页 span |
| `apps/api/src/nodes/execute.ts` | 执行链路：指纹 → 缓存命中 → 执行 → 落产物 → **下游只标 stale** |
| `apps/api/src/routes/run.ts` | `POST /v1/nodes/:id/run` 真正执行（`dryRun` 只算指纹） |

`source` 的失败语义：**有文字才算成功**。扫描件/纯图文件返回
`422 SOURCE_HAS_NO_TEXT_LAYER`，不建 Source 行以外的东西、不建 span、不生成内容。

---

## 2 · 10 个 Source 的实测结果

建画布 `M2 课件源验收`，每个 PPTX 一个 `SOURCE` 节点（`params.localPath`），逐份执行：

| 文件 | pageCount（幻灯片数） | SLIDE span | NOTES span | 空文本页 | text.json 字节 | checksum 前 12 |
| --- | --- | --- | --- | --- | --- | --- |
| ch3-1（1）.pptx | 9 | 9 | 0 | 0 | 966 | `1dcd582fc85c` |
| ch3-1（2）.pptx | 47 | 38 | 0 | 9 | 4352 | `fd689c1f80b0` |
| ch3-2.pptx | 44 | 39 | 0 | 5 | 4611 | `231215f4fac5` |
| ch3-3.pptx | 32 | 24 | 0 | 8 | 3847 | `9aa1fda0d416` |
| ch3-4.pptx | 32 | 18 | 0 | 14 | 2398 | `a69f7fd0ce02` |
| ch4-1.pptx | 15 | 13 | 0 | 2 | 1131 | `95fafec00d5b` |
| ch4-2.pptx | 13 | 13 | 0 | 0 | 1343 | `503cdf2615e9` |
| ch4-3.pptx | 23 | 19 | 0 | 4 | 1702 | `0cc90a268cfa` |
| ch4-4.pptx | 29 | 28 | 0 | 1 | 2957 | `000de9d11ad7` |
| ch4-5.pptx | 22 | 19 | 0 | 3 | 2214 | `7fca5925e1db` |
| **合计** | **266** | **220** | **0** | **46** | — | — |

三条一致性：

1. `pageCount` 合计 **266** = `scripts/count-pptx.mjs` 的幻灯片总数
2. 空文本页 **46** = 计数脚本的 `emptySlides` 合计；`266 − 46 = 220` = 实际 span 数
3. `pageCount` 是逐文件核对过的，不是所有文件填同一个数

**备注页为什么 NOTES span = 0**：这 10 份课件的 `ppt/notesSlides/` 里没有非空文本
（`ch4-5` 有 1 个 notesSlide，但内容为空）。抽取路径已经实现（`region='NOTES'`），
只是这批材料没有讲稿。这一点如实记录，不拿"实现了"冒充"验证过有备注"。

---

## 3 · 切片（chunk）

把 `ch3-1（1）.pptx` 的 SOURCE 接到一个 CHUNK 节点并执行：

```
CHUNK {"status":200,"outcome":"SUCCEEDED","chunks":9,
       "firstChunk":{"page":1,"chars":117,"spanIds":1}}
```

9 张幻灯片（该文件 0 空页）→ 9 个切片，每个切片的 `spanIds` 指向该页的 span。
`ChunkSet` 通过 zod schema 校验后才落 Artifact。

---

## 4 · 扫描件负例（SG-SUP-007 §5）

`课件/课本/高代.pdf`（380 页，抽样 5 页全 0 字符）：

```
NEGATIVE {"http":422,"code":"SOURCE_HAS_NO_TEXT_LAYER","sources":0,"spans":0,"concepts":0}
```

| 检查点 | 期望 | 实测 |
| --- | --- | --- |
| HTTP 状态 | 422 | 422 |
| errorCode | `SOURCE_HAS_NO_TEXT_LAYER` | 一致 |
| 该 Source 下的 Span 数 | 0 | **0** |
| 产出卡片 | 0 | **0**（该画布 Concept 总数 0） |
| 用户可见文案 | 说明"没有文字层、不支持 OCR" | `这份 PDF 没有文字层（可能是扫描件），M2 暂不支持 OCR：高代.pdf` |

`source` 节点执行失败 → `Run.status = FAILED`、`Node.status = ERROR`，
**没有任何卡片、没有 span、没有 Source 行**（Source 行只在抽到文字后创建）。

另一份扫描件（`理科数学分析`，261 页）同一路径，未单独重复跑——行为一致，不凑证据。

---

## 5 · 仍未做

| 项 | 原因 |
| --- | --- |
| `extract` / `card` 执行器 | **缺模型 key**：`OPENAI_API_KEY` 未配、`ANTHROPIC_API_KEY=""`、`ProviderCredential` 0 行 |
| 概念卡产出（≥15 或按 §4.2 下调到 10） | 同上 |
| 指纹缓存六场景（行为级） | 已有 `dryRun`/缓存命中/下游 stale 的实现，但"二次运行 tokensIn=0"要有 LLM 节点才有意义；`source`/`chunk` 的 usage 恒为 0 |
| 前端溯源抽屉 | 依赖卡片产物 |
| BullMQ 队列化 | M2 版是同步执行；队列不影响行为契约，等 LLM 节点接入时一起做 |
| `chunk` 的语义边界 | 现在是"一页一片"的确定性切法，没有跨页合并；材料只有 22 字/页，跨页合并反而会稀释断言 |

### 复跑命令

```bash
node scripts/count-pptx.mjs                 # 266 页 / 6098 字符
node tmp/m2-source-run.mjs                  # 10 份 PPTX 逐份执行 source（本机脚本）
node tmp/m2-source-verify.mjs               # 落库核对 + chunk + 扫描件负例
```

（`tmp/` 是本机开发脚本目录，已 gitignore；需要长期保留的脚本在 `scripts/`。）

---

## 6 · 一句话

课件这条链路现在是**真跑通**的：10 个文件 → 10 个 Source（266 页，与计数脚本逐项对齐）→
220 个 span（46 个空页如实留空）→ 9 个切片；扫描件按负例处理，0 span、0 卡。

剩下的一步只有一个前提：**模型 key**。
