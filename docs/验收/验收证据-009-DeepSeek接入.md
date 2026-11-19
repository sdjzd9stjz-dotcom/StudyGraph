# 009 独立验收证据

实现 a070ce4，工作区 71f788f。PowerShell 从项目根目录执行。HTTP 命令复用本机临时验收脚本的请求函数；终端输出不含密钥。E7 保留专用画布，替换文件只操作临时副本。E8 使用模拟模型回包和真实数据库事务，最后回滚。

## E1 真库

落点 `apps/api/src/nodes/executors/card.ts:65`，退出码 0。

```powershell
@'
SELECT c."canvasId",count(*),c.status FROM "Concept" c GROUP BY 1,3; SELECT c.name,c.definition,s.page,s.text FROM "Concept" c JOIN "ConceptCitation" cc ON cc."conceptId"=c.id JOIN "Span" s ON s.id=cc."spanId" WHERE c.status='VERIFIED' ORDER BY c.name LIMIT 30; SELECT provider,model,"tokensIn","tokensOut","cachedTokens" FROM "UsageRecord" WHERE provider='deepseek'; SELECT left(r.fingerprint,12),r."cacheHit",r."tokensIn",r."tokensOut",r."modelVersion" FROM "Run" r JOIN "Node" n ON r."nodeId"=n.id WHERE n.type='EXTRACT' ORDER BY r."createdAt"; SELECT count(*) FROM v_verified_without_citation;
'@ | docker exec -i studygraph-postgres psql -XAt -v ON_ERROR_STOP=1 -U studygraph -d studygraph
```

```text
cmwnemx2x001iq5l4jgx1k4sp|16|VERIFIED
三角函数及反三角函数的连续性|三角函数及反三角函数在它们的定义域内是连续的.|34|3. 初等函数的连续性三角函数及反三角函数在它们的定义域内是连续的.★★★
函数在一点连续必须满足的三个条件|函数在一点连续必须满足的三个条件|41|1.函数在一点连续必须满足的三个条件;3.间断点的分类与判别;2.区间上的连续函数;第一类间断点: 可去型, 跳跃型.第二类间断点: 无穷型, 振荡型.间断点(见下图)四、小结
初等函数的连续性|一切初等函数在其定义区间内都是连续的.|35|定理6  基本初等函数在其定义域内是连续的.★ 幂函数(均在其定义域内连续 )定理7  一切初等函数在其定义区间内都是连续的.定义区间是指包含在定义域内的区间.★ 幂指函数结论：在其有定义的区间内连续 
区间上的连续函数|区间上的连续函数|41|1.函数在一点连续必须满足的三个条件;3.间断点的分类与判别;2.区间上的连续函数;第一类间断点: 可去型, 跳跃型.第二类间断点: 无穷型, 振荡型.间断点(见下图)四、小结
可去型间断点|可去型间断点|42|可去型第一（三）类间断点oyx跳跃型无穷型振荡型第二（二）类间断点oyxoyxoyx第一（一）类间断点
可去间断点|只要改变或者补充间断处函数的定义,则可使其变为连续点的间断点。|14|解注意  可去间断点只要改变或者补充间断处函数的定义,  则可使其变为连续点.例6
基本初等函数的连续性|基本初等函数在其定义域内是连续的.|35|定理6  基本初等函数在其定义域内是连续的.★ 幂函数(均在其定义域内连续 )定理7  一切初等函数在其定义区间内都是连续的.定义区间是指包含在定义域内的区间.★ 幂指函数结论：在其有定义的区间内连续 
定义区间|定义区间是指包含在定义域内的区间.|35|定理6  基本初等函数在其定义域内是连续的.★ 幂函数(均在其定义域内连续 )定理7  一切初等函数在其定义区间内都是连续的.定义区间是指包含在定义域内的区间.★ 幂指函数结论：在其有定义的区间内连续 
无穷型间断点|无穷型间断点|42|可去型第一（三）类间断点oyx跳跃型无穷型振荡型第二（二）类间断点oyxoyxoyx第一（一）类间断点
狄利克雷函数|狄利克雷函数在定义域R内每一点处都间断,且都是第二类间断点.|18|狄利克雷函数在定义域R内每一点处都间断,且都是第二类间断点.仅在 x = 0 处连续,  其余各点处处间断.★★
第二类间断点|左、右极限有一个不存在的或都不存在的点。|16|例7解注意: 第二类间断点是左、右极限有一个不存在的或都不存在的点
跳跃型间断点|跳跃型间断点|42|可去型第一（三）类间断点oyx跳跃型无穷型振荡型第二（二）类间断点oyxoyxoyx第一（一）类间断点
连续函数|在区间上每一点都连续的函数,叫做在该区间上的连续函数,或者说函数在该区间上连续.|6|3. 连续函数与连续区间在区间上每一点都连续的函数,叫做在该区间上的连续函数,或者说函数在该区间上连续.连续函数的图形是一条连续而不间断的曲线.
连续函数的四则运算与初等函数的连续性|连续函数的和差积商的连续性.复合函数的连续性.初等函数的连续性.反函数的连续性.|43|4.连续函数的四则运算与初等函数的连续性 连续函数的和差积商的连续性.复合函数的连续性.初等函数的连续性.反函数的连续性.
连续区间|连续函数所在的区间（函数在该区间上每一点都连续）。|6|3. 连续函数与连续区间在区间上每一点都连续的函数,叫做在该区间上的连续函数,或者说函数在该区间上连续.连续函数的图形是一条连续而不间断的曲线.
间断点的分类与判别|间断点的分类与判别|41|1.函数在一点连续必须满足的三个条件;3.间断点的分类与判别;2.区间上的连续函数;第一类间断点: 可去型, 跳跃型.第二类间断点: 无穷型, 振荡型.间断点(见下图)四、小结
deepseek|deepseek-flash|427|5|256
deepseek|deepseek-flash|1683|843|0
deepseek|deepseek-flash|1758|730|0
deepseek|deepseek-flash|1794|771|0
e327fcd53196|f|0|0|
d2c10d86b03f|f|427|5|
f795ab3f6d8e|f|1683|843|
f795ab3f6d8e|t|0|0|
33b7789d387e|f|1758|730|
dae44a1b9313|f|1794|771|
0
```

## E2 卫生

落点 `docs/指令/监理指令-009-接入DeepSeek.md:37`，退出码 0。

```powershell
git check-ignore -v .env; git grep -l -E 'sk-[[:alnum:]]{32,}'; git log --all --format=%h -G 'sk-[[:alnum:]]{32,}'; node --env-file=.env -e "console.log('credentialAvailable',Boolean(process.env.DEEPSEEK_API_KEY?.trim()))"
```

```text
.gitignore:11:.env	.env
credentialAvailable false
```

## E3 测试

落点 `apps/api/test/unit/text-layer.test.ts:1`，退出码 0。

```powershell
foreach($f in (rg --files apps/api/test/unit packages/contracts/test -g '*.test.ts')) { $o=@(node $f); Write-Output "$f $($o -match '(pass|fail) [0-9]+') exit=$LASTEXITCODE" }
```

```text
packages/contracts/test\ports.test.ts ℹ pass 27 ℹ fail 0 exit=0
packages/contracts/test\fingerprint.test.ts ℹ pass 10 ℹ fail 0 exit=0
apps/api/test/unit\text-layer.test.ts ℹ pass 6 ℹ fail 0 exit=0
apps/api/test/unit\startup-selfcheck.test.ts ℹ pass 2 ℹ fail 0 exit=0
apps/api/test/unit\spans.test.ts ℹ pass 10 ℹ fail 0 exit=0
apps/api/test/unit\span-cache-equivalence.test.ts ℹ pass 2 ℹ fail 0 exit=0
apps/api/test/unit\registry.test.ts ℹ pass 9 ℹ fail 0 exit=0
apps/api/test/unit\llm-prefix.test.ts ℹ pass 6 ℹ fail 0 exit=0
apps/api/test/unit\gateway.test.ts ℹ pass 13 ℹ fail 0 exit=0
apps/api/test/unit\dag.test.ts ℹ pass 13 ℹ fail 0 exit=0
apps/api/test/unit\auth.test.ts ℹ pass 10 ℹ fail 0 exit=0
```

## E4 适配器

落点 `apps/api/src/llm/providers/deepseek.ts:35`，退出码 0。

```powershell
node --input-type=module -e "import {createDeepSeekProvider as create} from './apps/api/src/llm/providers/deepseek.ts';for(const patch of [{},{prompt_cache_hit_tokens:0},{prompt_cache_hit_tokens:128}]){const f=create({apiKey:'fixture',fetchImpl:async()=>Response.json({model:'snapshot',choices:[{message:{content:'{}'}}],usage:{prompt_tokens:150,completion_tokens:2,...patch}})});try{console.log(JSON.stringify(patch),JSON.stringify(await f({model:'alias',messages:[]})))}catch(e){console.log(e.code)}}"
```

```text
{} {"data":{},"usage":{"tokensIn":150,"tokensOut":2,"cachedTokens":0},"modelVersion":"snapshot"}
{"prompt_cache_hit_tokens":0} {"data":{},"usage":{"tokensIn":150,"tokensOut":2,"cachedTokens":0},"modelVersion":"snapshot"}
{"prompt_cache_hit_tokens":128} {"data":{},"usage":{"tokensIn":150,"tokensOut":2,"cachedTokens":128},"modelVersion":"snapshot"}
```

## E5 资料闸门

落点 `apps/api/src/nodes/executors/source.ts:40`，退出码 0。

```powershell
node tmp/gate-check.mjs
```

```text
{"file":"高代.pdf","pages":380,"nonEmpty":0,"effective":0,"ratio":0,"signals":0,"usable":false}
{"file":"、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf","pages":261,"nonEmpty":29,"effective":7,"ratio":0.027,"signals":2,"usable":false}
{"file":"ch3-4.pptx","slides":32,"nonEmpty":18,"effective":7,"ratio":0.219,"signals":0,"usable":true}
{"file":"ch3-1（1）.pptx","slides":9,"nonEmpty":9,"effective":3,"ratio":0.333,"signals":0,"usable":true}
```

## E6 指纹实现

落点 `apps/api/src/nodes/execute.ts:103`，退出码 0。

```powershell
rg -n 'modelVersion: executor|modelVersion: .llm.|node.fingerprint === fingerprint' apps/api/src/nodes/execute.ts; rg -n 'const verified =|quote: claim.definition|provider: .deepseek.' apps/api/src/nodes/executors
```

```text
103:    modelVersion: executor.promptVersion === 'no-prompt' ? 'rule-based-v1' : 'llm',
107:  const cacheHit = node.fingerprint === fingerprint
apps/api/src/nodes/executors\card.ts:65:          quote: claim.definition.slice(0, 200),
apps/api/src/nodes/executors\extract.ts:116:        provider: 'deepseek',
apps/api/src/nodes/executors\extract.ts:144:        const verified = quote.length > 0 && chunk.text.includes(quote)
```

## E7 HTTP

落点 `apps/api/src/routes/run.ts:1`，退出码 0。

```powershell
$h=(Get-Content -Raw -Encoding utf8 tmp/m2-source-run.mjs).Split('const files = []')[0]
$q=@'
import fs from 'node:fs';import {randomUUID} from 'node:crypto'
const tag=randomUUID();const canvas=(await call('POST','/v1/canvases',{title:'009 独立复验 '+tag})).json
if(!canvas.id)throw Error('canvas unavailable')
const files=fs.readdirSync('课件',{recursive:true}).map(x=>path.resolve('课件',x))
const tmp=path.resolve('tmp','audit-'+tag+'.pptx');const make=async f=>(await call('POST','/v1/canvases/'+canvas.id+'/nodes',{type:'SOURCE',params:{localPath:f}})).json.id
const run=async id=>{const r=await call('POST','/v1/nodes/'+id+'/run');console.log(r.status,r.json?.status??r.json?.error?.code,r.json?.fingerprint?.slice(0,12)??'')}
try{const p=files.filter(x=>x.endsWith('.pptx')).sort();fs.copyFileSync(p[0],tmp);const n=await make(tmp);await run(n);await run(n);fs.copyFileSync(p[1],tmp);await run(n);for(const f of files.filter(x=>x.endsWith('.pdf')))await run(await make(f))}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);console.log('auditCanvas',canvas.id)}
'@
($h+$q) | node --input-type=module
```

```text
200 SUCCEEDED 356dec5681fd
200 CACHED 356dec5681fd
200 SUCCEEDED 54275ffdea3e
422 SOURCE_TEXT_LAYER_UNUSABLE 
422 SOURCE_HAS_NO_TEXT_LAYER 
auditCanvas cmwnf07ga0001q5fwwqar9451
```

## E8 引文反例

落点 `apps/api/src/nodes/executors/extract.ts:144`，退出码 0。

```powershell
@'
import {prisma} from './packages/db/src/index.ts'
import {extractExecutor as ex} from './apps/api/src/nodes/executors/extract.ts'
import {cardExecutor as card} from './apps/api/src/nodes/executors/card.ts'
try{await prisma.$transaction(async tx=>{const c=await tx.concept.findFirstOrThrow({where:{name:'狄利克雷函数'},include:{citations:{include:{span:true}}}});const s=c.citations[0].span;const bad={chunk:0,name:'009audit',definition:'鲸鱼是一种行星',quote:s.text.slice(0,5)};const r=await ex.run({params:{},inputs:{chunkSet:{sourceId:s.sourceId,chunks:[{pageStart:s.page,text:s.text,spanIds:[s.id]}]}},llm:{complete:async()=>({modelVersion:'audit',usage:{tokensIn:1,tokensOut:1,cachedTokens:0},data:{claims:[bad]}})}});const v=await card.run({prisma:tx,canvasId:c.canvasId,inputs:r.outputs});console.log('unsupported_claim',r.outputs.conceptClaims.claims[0].status,'cardsVerified',v.outputs.cards.verified);throw Error('AUDIT_ROLLBACK')})}catch(e){if(e.message!=='AUDIT_ROLLBACK')throw e}finally{await prisma.$disconnect()}
'@ | node --env-file=.env --input-type=module
```

```text
unsupported_claim VERIFIED cardsVerified 1
```

## E9 切片

落点 `apps/api/src/nodes/executors/chunk.ts:72`，退出码 0。

```powershell
node --input-type=module -e "import {chunkExecutor as c} from './apps/api/src/nodes/executors/chunk.ts';let text='ABCDE';let r=await c.run({params:{maxChars:2},inputs:{sourceDoc:{sourceId:'doc'}},prisma:{span:{findMany:async()=>[{id:'s',page:1,region:'SLIDE',text}]}}});console.log(r.outputs.chunkSet.chunks.map(x=>x.text).join('|'))"
```

```text
AB|CD|E
```

## E10 区域

落点 `apps/api/src/spans/citation-integrity.ts:55`，退出码 0。

```powershell
node --input-type=module -e "import {checkConceptCitations as f} from './apps/api/src/spans/citation-integrity.ts';for(const text of ['A','B']){const span={id:'s',sourceId:'src',source:{node:{canvasId:'cv'}},region:'SLIDE',page:1,charStart:0,charEnd:1,text};const r=await f({prisma:{concept:{findMany:async()=>[{id:'c',citations:[{span}]}],update:async()=>{}}},objectStore:{get:async()=>Buffer.from(JSON.stringify([{page:1,region:'SLIDE',text:'A'},{page:1,region:'NOTES',text:'B'}]))}});console.log(text,JSON.stringify(r.downgraded))}"
```

```text
A ["c"]
B []
```

## E11 服务凭据

落点 `apps/api/src/routes/system.ts:1`，退出码 0。

```powershell
$h=(Get-Content -Raw -Encoding utf8 tmp/m2-source-run.mjs).Split('const files = []')[0]; ($h+"const r=await call('GET','/v1/system/credential?provider=deepseek'); console.log('status',r.status,'configured',r.json?.configured??false,'code',r.json?.error?.code??'-')") | node --input-type=module
```

```text
status 400 configured false code VALIDATION_FAILED
```

## E12 计数复查

落点 `apps/api/src/nodes/executors/card.ts:65`，退出码 0。

```powershell
docker exec studygraph-postgres psql -U studygraph -d studygraph -At -c 'SELECT count(*), count(*) FILTER (WHERE name=definition) FROM "Concept" WHERE "canvasId"=''cmwnemx2x001iq5l4jgx1k4sp''; SELECT jsonb_array_length(structured->''conceptClaims''->''claims'') FROM "Artifact" a JOIN "Node" n ON n.id=a."nodeId" WHERE n."canvasId"=''cmwnemx2x001iq5l4jgx1k4sp'' AND a.kind=''CONCEPT_CLAIMS'' ORDER BY a."createdAt"; SELECT count(*) FROM "ProviderCredential" WHERE "isActive"=true;'
```

```text
16|6
16
17
19
0
```

## E13 备用路由与文档

落点 `apps/api/src/llm/routing.ts:32`，退出码 1。

```powershell
rg -n 'deepseek|OPENAI_SMALL_ROUTE|ANTHROPIC_FRONTIER_ROUTE' apps/api/src/llm/routing.ts; rg -il deepseek docs/architecture.md; Write-Output "architectureScanExit=$LASTEXITCODE"; rg --hidden --no-ignore -l 'sk-[a-zA-Z0-9]{32,}' -g '!**/node_modules/**' -g '!.git/**' -g '!.pnpm-store/**' -g '!**/.next/**' -g '!课件/**' . | Measure-Object | Select-Object -ExpandProperty Count
```

```text
3:export type ProviderId = 'openai' | 'anthropic' | 'deepseek'
27:const DEEPSEEK_CHAT = process.env.STUDYGRAPH_DEEPSEEK_MODEL ?? 'deepseek-chat'
28:const DEEPSEEK_REASONER = process.env.STUDYGRAPH_DEEPSEEK_REASONER ?? 'deepseek-reasoner'
32:  chunk: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small' },
33:  extract: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small' },
34:  judge: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small' },
35:  quiz: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small' },
36:  check: { provider: 'deepseek', model: DEEPSEEK_CHAT, tier: 'small' },
38:  probe: { provider: 'deepseek', model: DEEPSEEK_REASONER, tier: 'frontier' },
39:  method: { provider: 'deepseek', model: DEEPSEEK_REASONER, tier: 'frontier' },
40:  solve: { provider: 'deepseek', model: DEEPSEEK_REASONER, tier: 'frontier' },
41:  variant: { provider: 'deepseek', model: DEEPSEEK_REASONER, tier: 'frontier' },
48:export const OPENAI_SMALL_ROUTE: ModelRoute = { provider: 'openai', model: SMALL_MODEL, tier: 'small' }
49:export const ANTHROPIC_FRONTIER_ROUTE: ModelRoute = {
architectureScanExit=1
0
```
