# 008 验收证据

版本 `9e4622b`。PowerShell，从项目根目录执行。为便于复查，本次画布及入库产物保留在本机；逐页核对和 SQL 中的画布 ID 对应本次运行，另建画布时请替换。tmp 下的入口为本机现存脚本。独立 XML 检查的两个全角文件名在终端显示乱码，校验使用原始 Unicode 名称。

## E1 导入

落点 `tmp/m2-source-run.mjs:1`，退出码 0。

```powershell
& 'C:/Program Files/nodejs/node.exe' --env-file=.env tmp/m2-source-run.mjs
```

```text
canvas cmwna2bsu00f7q5qg2fi7ou1j files 10
{"file":"ch3-1（1）.pptx","http":200,"outcome":"SUCCEEDED","code":null}
{"file":"ch3-1（2）.pptx","http":200,"outcome":"SUCCEEDED","code":null}
{"file":"ch3-2.pptx","http":200,"outcome":"SUCCEEDED","code":null}
{"file":"ch3-3.pptx","http":200,"outcome":"SUCCEEDED","code":null}
{"file":"ch3-4.pptx","http":200,"outcome":"SUCCEEDED","code":null}
{"file":"ch4-1.pptx","http":200,"outcome":"SUCCEEDED","code":null}
{"file":"ch4-2.pptx","http":200,"outcome":"SUCCEEDED","code":null}
{"file":"ch4-3.pptx","http":200,"outcome":"SUCCEEDED","code":null}
{"file":"ch4-4.pptx","http":200,"outcome":"SUCCEEDED","code":null}
{"file":"ch4-5.pptx","http":200,"outcome":"SUCCEEDED","code":null}
FIRST_NODE cmwna2btc00f9q5qg98mofr3z
ROWS [{"file":"ch3-1（1）.pptx","nodeId":"cmwna2btc00f9q5qg98mofr3z","runStatus":200,"outcome":"SUCCEEDED"},{"file":"ch3-1（2）.pptx","nodeId":"cmwna2bvt00fzq5qg0qx5pyul","runStatus":200,"outcome":"SUCCEEDED"},{"file":"ch3-2.pptx","nodeId":"cmwna2c0600ibq5qgva2rmxal","runStatus":200,"outcome":"SUCCEEDED"},{"file":"ch3-3.pptx","nodeId":"cmwna2c3a00kpq5qgzpjw7ojv","runStatus":200,"outcome":"SUCCEEDED"},{"file":"ch3-4.pptx","nodeId":"cmwna2c5p00m9q5qgj7gxoc89","runStatus":200,"outcome":"SUCCEEDED"},{"file":"ch4-1.pptx","nodeId":"cmwna2c8s00nhq5qgpcqsj59h","runStatus":200,"outcome":"SUCCEEDED"},{"file":"ch4-2.pptx","nodeId":"cmwna2cag00ofq5qgdsrhy1ou","runStatus":200,"outcome":"SUCCEEDED"},{"file":"ch4-3.pptx","nodeId":"cmwna2cc300pdq5qg7dwsharx","runStatus":200,"outcome":"SUCCEEDED"},{"file":"ch4-4.pptx","nodeId":"cmwna2cf200qnq5qgvsydpx60","runStatus":200,"outcome":"SUCCEEDED"},{"file":"ch4-5.pptx","nodeId":"cmwna2cij00sfq5qgwoqc5lkb","runStatus":200,"outcome":"SUCCEEDED"}]
```

## E2 计数

落点 `scripts/count-pptx.mjs:1`，退出码 0。

```powershell
node scripts/count-pptx.mjs
```

```text
{
  "files": [
    {
      "file": "ch3-1（1）.pptx",
      "slides": 9,
      "notesSlides": 0,
      "slideChars": 253,
      "slideCharsTrimmed": 219,
      "slideCharsNonEmpty": 246,
      "notesChars": 0,
      "emptySlides": 0,
      "masterAndLayoutCharsExcluded": 361
    },
    {
      "file": "ch3-1（2）.pptx",
      "slides": 47,
      "notesSlides": 0,
      "slideChars": 959,
      "slideCharsTrimmed": 910,
      "slideCharsNonEmpty": 943,
      "notesChars": 0,
      "emptySlides": 9,
      "masterAndLayoutCharsExcluded": 368
    },
    {
      "file": "ch3-2.pptx",
      "slides": 44,
      "notesSlides": 3,
      "slideChars": 1137,
      "slideCharsTrimmed": 1045,
      "slideCharsNonEmpty": 1132,
      "notesChars": 0,
      "emptySlides": 5,
      "masterAndLayoutCharsExcluded": 368
    },
    {
      "file": "ch3-3.pptx",
      "slides": 32,
      "notesSlides": 0,
      "slideChars": 1023,
      "slideCharsTrimmed": 903,
      "slideCharsNonEmpty": 992,
      "notesChars": 0,
      "emptySlides": 8,
      "masterAndLayoutCharsExcluded": 368
    },
    {
      "file": "ch3-4.pptx",
      "slides": 32,
      "notesSlides": 0,
      "slideChars": 544,
      "slideCharsTrimmed": 353,
      "slideCharsNonEmpty": 418,
      "notesChars": 0,
      "emptySlides": 14,
      "masterAndLayoutCharsExcluded": 368
    },
    {
      "file": "ch4-1.pptx",
      "slides": 15,
      "notesSlides": 0,
      "slideChars": 240,
      "slideCharsTrimmed": 190,
      "slideCharsNonEmpty": 237,
      "notesChars": 0,
      "emptySlides": 2,
      "masterAndLayoutCharsExcluded": 361
    },
    {
      "file": "ch4-2.pptx",
      "slides": 13,
      "notesSlides": 0,
      "slideChars": 354,
      "slideCharsTrimmed": 302,
      "slideCharsNonEmpty": 333,
      "notesChars": 0,
      "emptySlides": 0,
      "masterAndLayoutCharsExcluded": 368
    },
    {
      "file": "ch4-3.pptx",
      "slides": 23,
      "notesSlides": 0,
      "slideChars": 315,
      "slideCharsTrimmed": 294,
      "slideCharsNonEmpty": 312,
      "notesChars": 0,
      "emptySlides": 4,
      "masterAndLayoutCharsExcluded": 368
    },
    {
      "file": "ch4-4.pptx",
      "slides": 29,
      "notesSlides": 0,
      "slideChars": 693,
      "slideCharsTrimmed": 647,
      "slideCharsNonEmpty": 673,
      "notesChars": 0,
      "emptySlides": 1,
      "masterAndLayoutCharsExcluded": 368
    },
    {
      "file": "ch4-5.pptx",
      "slides": 22,
      "notesSlides": 1,
      "slideChars": 580,
      "slideCharsTrimmed": 463,
      "slideCharsNonEmpty": 555,
      "notesChars": 0,
      "emptySlides": 3,
      "masterAndLayoutCharsExcluded": 368
    }
  ],
  "totals": {
    "slides": 266,
    "slideChars": 6098,
    "slideCharsTrimmed": 5326,
    "slideCharsNonEmpty": 5841,
    "notesChars": 0,
    "emptySlides": 46,
    "masterChars": 3666
  }
}
```

## E3 回归

落点 `apps/api/test/unit/span-cache-equivalence.test.ts:1`，退出码 0。

```powershell
foreach($f in (rg --files apps/api/test/unit packages/contracts/test -g '*.test.ts')) { $o=@(node $f); Write-Output "$f $($o -match '(pass|fail) [0-9]+') exit=$LASTEXITCODE" }
```

```text
packages/contracts/test\ports.test.ts ℹ pass 27 ℹ fail 0 exit=0
packages/contracts/test\fingerprint.test.ts ℹ pass 10 ℹ fail 0 exit=0
apps/api/test/unit\startup-selfcheck.test.ts ℹ pass 2 ℹ fail 0 exit=0
apps/api/test/unit\spans.test.ts ℹ pass 10 ℹ fail 0 exit=0
apps/api/test/unit\span-cache-equivalence.test.ts ℹ pass 2 ℹ fail 0 exit=0
apps/api/test/unit\registry.test.ts ℹ pass 9 ℹ fail 0 exit=0
apps/api/test/unit\llm-prefix.test.ts ℹ pass 6 ℹ fail 0 exit=0
apps/api/test/unit\gateway.test.ts ℹ pass 13 ℹ fail 0 exit=0
apps/api/test/unit\dag.test.ts ℹ pass 13 ℹ fail 0 exit=0
apps/api/test/unit\auth.test.ts ℹ pass 10 ℹ fail 0 exit=0
```

## E4 截断

落点 `apps/api/src/nodes/executors/chunk.ts:49`，退出码 0。

```powershell
node --input-type=module -e "import {chunkExecutor as c} from './apps/api/src/nodes/executors/chunk.ts';let text='ABCDE';let r=await c.run({params:{maxChars:2},inputs:{sourceDoc:{sourceId:'doc'}},prisma:{span:{findMany:async()=>[{id:'s',page:1,region:'SLIDE',text}]}}});console.log('source='+text,'chunk='+r.outputs.chunkSet.chunks.map(x=>x.text).join(''))"
```

```text
source=ABCDE chunk=AB
```

## E5 逐页独立核对

落点 `apps/api/src/storage/pptx.ts:105`，退出码 0。

```powershell
@'
import subprocess,json,zipfile,hashlib,posixpath
from pathlib import Path
import xml.etree.ElementTree as ET
cv='cmwna2bsu00f7q5qg2fi7ou1j'
q="""select coalesce(json_agg(row_to_json(x)), '[]') from (select s.filename,s.checksum,s."pageCount",p.page,p.text,p."charStart",p."charEnd" from "Source" s join "Node" n on n.id=s."nodeId" left join "Span" p on p."sourceId"=s.id and p.region='SLIDE' where n."canvasId"='%s') x"""%cv
rows=json.loads(subprocess.check_output(['docker','exec','studygraph-postgres','psql','-U','studygraph','-d','studygraph','-Atc',q]))
for f in sorted(Path('课件').rglob('*.pptx')):
 r=[x for x in rows if x['filename']==f.name]; by={x['page']:x for x in r}; bad=[];sizes=[];blank=0
 with zipfile.ZipFile(f) as z:
  e=lambda n: ET.fromstring(z.read(n))
  rel={a.get('Id'):a.get('Target') for a in e('ppt/_rels/presentation.xml.rels')}
  for i,slide in enumerate(e('ppt/presentation.xml').findall('.//{*}sldIdLst/{*}sldId'),1):
   ref=next(v for k,v in slide.attrib.items() if k.endswith('}id')); part=posixpath.normpath(posixpath.join('ppt',rel[ref])).lstrip('/')
   txt=''.join(x.text or '' for x in e(part).iter('{http://schemas.openxmlformats.org/drawingml/2006/main}t')); n=len(txt.encode('utf-16-le'))//2;sizes.append(n); blank+=not txt.strip()
   v=by.get(i);ok=(not v) if not txt.strip() else bool(v and (v['text'],v['charStart'],v['charEnd'])==(txt,0,n))
   if not ok:bad.append(i)
 print(f.name,len(sizes),sum(sizes),blank,'wrongPages',bad,'metaOK',bool(r and r[0]['pageCount']==len(sizes) and r[0]['checksum']==hashlib.sha256(f.read_bytes()).hexdigest()))
'@ | & 'C:/Users/terry/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe' -
```

```text
ch3-1��1��.pptx 9 253 0 wrongPages [] metaOK True
ch3-1��2��.pptx 47 959 9 wrongPages [] metaOK True
ch3-2.pptx 44 1137 5 wrongPages [] metaOK True
ch3-3.pptx 32 1023 8 wrongPages [] metaOK True
ch3-4.pptx 32 544 14 wrongPages [] metaOK True
ch4-1.pptx 15 240 2 wrongPages [] metaOK True
ch4-2.pptx 13 354 0 wrongPages [] metaOK True
ch4-3.pptx 23 315 4 wrongPages [] metaOK True
ch4-4.pptx 29 693 1 wrongPages [] metaOK True
ch4-5.pptx 22 580 3 wrongPages [] metaOK True
```

## E6 切片及扫描件

落点 `tmp/m2-source-verify.mjs:1`，退出码 0。

```powershell
& 'C:/Program Files/nodejs/node.exe' --env-file=.env tmp/m2-source-verify.mjs
```

```text
[
 {
  "file": "ch3-1（1）.pptx",
  "pageCount": 9,
  "slideSpans": 9,
  "notesSpans": 0,
  "emptySlides": 0,
  "textJsonBytes": 966,
  "checksum": "1dcd582fc85c"
 },
 {
  "file": "ch3-1（2）.pptx",
  "pageCount": 47,
  "slideSpans": 38,
  "notesSpans": 0,
  "emptySlides": 9,
  "textJsonBytes": 4352,
  "checksum": "fd689c1f80b0"
 },
 {
  "file": "ch3-2.pptx",
  "pageCount": 44,
  "slideSpans": 39,
  "notesSpans": 0,
  "emptySlides": 5,
  "textJsonBytes": 4611,
  "checksum": "231215f4fac5"
 },
 {
  "file": "ch3-3.pptx",
  "pageCount": 32,
  "slideSpans": 24,
  "notesSpans": 0,
  "emptySlides": 8,
  "textJsonBytes": 3847,
  "checksum": "9aa1fda0d416"
 },
 {
  "file": "ch3-4.pptx",
  "pageCount": 32,
  "slideSpans": 18,
  "notesSpans": 0,
  "emptySlides": 14,
  "textJsonBytes": 2398,
  "checksum": "a69f7fd0ce02"
 },
 {
  "file": "ch4-1.pptx",
  "pageCount": 15,
  "slideSpans": 13,
  "notesSpans": 0,
  "emptySlides": 2,
  "textJsonBytes": 1131,
  "checksum": "95fafec00d5b"
 },
 {
  "file": "ch4-2.pptx",
  "pageCount": 13,
  "slideSpans": 13,
  "notesSpans": 0,
  "emptySlides": 0,
  "textJsonBytes": 1343,
  "checksum": "503cdf2615e9"
 },
 {
  "file": "ch4-3.pptx",
  "pageCount": 23,
  "slideSpans": 19,
  "notesSpans": 0,
  "emptySlides": 4,
  "textJsonBytes": 1702,
  "checksum": "0cc90a268cfa"
 },
 {
  "file": "ch4-4.pptx",
  "pageCount": 29,
  "slideSpans": 28,
  "notesSpans": 0,
  "emptySlides": 1,
  "textJsonBytes": 2957,
  "checksum": "000de9d11ad7"
 },
 {
  "file": "ch4-5.pptx",
  "pageCount": 22,
  "slideSpans": 19,
  "notesSpans": 0,
  "emptySlides": 3,
  "textJsonBytes": 2214,
  "checksum": "7fca5925e1db"
 }
]
TOTALS {"slides":266,"spans":220,"empty":46}
CHUNK {"status":200,"outcome":"SUCCEEDED","chunks":9,"firstChunk":{"page":1,"chars":117,"spanIds":1}}
NEGATIVE {"http":422,"code":"SOURCE_HAS_NO_TEXT_LAYER","sources":0,"spans":0,"concepts":0}
```

## E7 换文件及第二份扫描件

落点 `apps/api/src/nodes/execute.ts:96`，退出码 0。

```powershell
@'
import {prisma} from './packages/db/src/index.ts'
import {executeNode} from './apps/api/src/nodes/execute.ts'
import {registerBuiltinExecutors} from './apps/api/src/nodes/executors/index.ts'
import {createObjectStore} from './apps/api/src/storage/object-store.ts'
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto'
registerBuiltinExecutors()
const canvasId='cmwna2bsu00f7q5qg2fi7ou1j',e=process.env, deps={prisma,objectStore:createObjectStore({endpoint:e.S3_ENDPOINT,bucket:e.S3_BUCKET,region:e.S3_REGION,accessKeyId:e.S3_ACCESS_KEY_ID,secretAccessKey:e.S3_SECRET_ACCESS_KEY}),llm:{},user:{}}
async function make(localPath){return (await prisma.node.create({data:{canvasId,type:'SOURCE',params:{localPath},posX:0,posY:0}})).id}
const run=id=>executeNode(deps,id,{dryRun:false})
const f=path.resolve('tmp','audit-'+randomUUID()+'.pptx')
try{const files=fs.readdirSync('课件',{recursive:true}).filter(x=>String(x).endsWith('.pptx')).sort()
fs.copyFileSync(path.join('课件',files[0]),f);const id=await make(f);console.log('first',(await run(id)).status);fs.copyFileSync(path.join('课件',files[1]),f);console.log('replacement',(await run(id)).status)
const pdf=fs.readdirSync('课件/课本').find(x=>x.includes('数学分析'));const n=await make(path.resolve('课件/课本',pdf));try{await run(n)}catch(err){console.log(err.status,err.code,err.message)}console.log('negativeSources',await prisma.source.count({where:{nodeId:n}}))
}finally{if(fs.existsSync(f))fs.unlinkSync(f);await prisma.$disconnect()}
'@ | node --env-file=.env --input-type=module
```

```text
first SUCCEEDED
replacement CACHED
negativeSources 1
```

## E8 区域巡检

落点 `apps/api/src/spans/citation-integrity.ts:55`，退出码 0。

```powershell
node --input-type=module -e "import {checkConceptCitations as check} from './apps/api/src/spans/citation-integrity.ts';for(const quote of ['A','B']){const span={id:'s',sourceId:'src',source:{node:{canvasId:'cv'}},region:'SLIDE',page:1,charStart:0,charEnd:1,text:quote};const r=await check({prisma:{concept:{findMany:async()=>[{id:'c',citations:[{span}]}],update:async()=>{}}},objectStore:{get:async()=>Buffer.from(JSON.stringify([{page:1,region:'SLIDE',text:'A'},{page:1,region:'NOTES',text:'B'}]))}});console.log('slideQuote',quote,'downgraded',JSON.stringify(r.downgraded))}"
```

```text
slideQuote A downgraded ["c"]
slideQuote B downgraded []
```

## E9 库状态

落点 `apps/api/src/nodes/execute.ts:206`，退出码 0。

```powershell
docker exec studygraph-postgres psql -U studygraph -d studygraph -At -c 'SELECT count(*) FROM v_verified_without_citation; SELECT n.status,r.status,r."errorCode",r."errorMessage" FROM "Run" r JOIN "Node" n ON n.id=r."nodeId" WHERE n."canvasId"=''cmwna2bsu00f7q5qg2fi7ou1j'' AND r.status=''FAILED'';'
```

```text
0
ERROR|FAILED|SOURCE_HAS_NO_TEXT_LAYER|这份 PDF 没有文字层（可能是扫描件），M2 暂不支持 OCR：高代.pdf
```

## E10 数学分析文字层

落点 `apps/api/src/nodes/executors/source.ts:40`，退出码 0。

```powershell
docker exec studygraph-postgres psql -U studygraph -d studygraph -At -c 'SELECT s.filename,s."pageCount",p.page,char_length(p.text),left(p.text,60) FROM "Source" s JOIN "Span" p ON p."sourceId"=s.id JOIN "Node" n ON n.id=s."nodeId" WHERE n."canvasId"=''cmwna2bsu00f7q5qg2fi7ou1j'' AND s.kind=''PDF'' ORDER BY p.page;'
```

```text
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|13|7|⾃ 整 有理实
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|17|9|XEX 唯⼀yEY
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|19|1|⼀
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|33|5|4 1 出
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|40|1|i
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|46|23|ntiiHiin.lk nlHn t1 htl
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|47|55|苦 tO'P 1时⼀⼀an Hit it 六71⼗ it it ⼥ ⼥⼗平 ⼗合 ⼀⼆1⼗1⼗ 1t.i.tl
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|66|2|ǐX
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|73|1|⼀
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|75|31|X_x x̅ ilnleX_x 1 1 右 eX_x 中 ⼆三
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|76|7|ㄨ 20 Xe
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|79|1|ˊ
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|110|1|n
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|112|1|0
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|120|3|000
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|155|1|⼀
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|160|1|y
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|163|33|féiidx⼆fed et州品贸品然品poTikxi cl u l
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|165|1|亢
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|166|25|Wi exit xi fix iii xifa 蝱
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|167|15|i wioxi dioxide
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|171|15|Fix⼆ losinix.tl
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|172|39|f x 4inx 1 dX19sint dtloXhintdtFc sinx2
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|193|1|8
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|195|1|⼆
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|233|3|1 1
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|237|43|ˇ i ˇˇ ˊˇ ix 4 1ˇi 三六 0pu ti 六 ⽉ ˇ两个端点换天 ˊˊ
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|238|24|1 缨 dx 令 i tlie itJi edt
、理科数学分析（上册）_15184362(1) (2) 拷贝.pdf|261|239|6|分析瑕点位昌
```
