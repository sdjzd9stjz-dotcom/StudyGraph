// Run with: node --env-file=.env apps/api/test/integration/extract-evidence.test.ts
// Only provider responses are simulated. Database and page objects are real.
import assert from 'node:assert/strict'
import test from 'node:test'
import { prisma } from '../../../../packages/db/src/index.ts'
import { executeNode } from '../../src/nodes/execute.ts'
import { registerBuiltinExecutors } from '../../src/nodes/executors/index.ts'
import { createGateway } from '../../src/llm/gateway.ts'
import { TASK_ROUTING } from '../../src/llm/routing.ts'
import { createObjectStore } from '../../src/storage/object-store.ts'
import { pageTextKey, writePageTexts } from '../../src/storage/page-text.ts'
import { checkConceptCitations } from '../../src/spans/citation-integrity.ts'
import { randomUUID } from 'node:crypto'

test('版本隔离、真实供应商归账、区域核验及无源定义拦截', async () => {
  registerBuiltinExecutors()
  const store = createObjectStore({ endpoint: process.env.S3_ENDPOINT, bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION, accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY })
  const user = await prisma.user.create({data:{email:randomUUID()+'@audit.invalid',displayName:'audit'}})
  let objectKey = ''
  try {
    const canvas = await prisma.canvas.create({data:{ownerId:user.id,title:'模型和溯源回归'}})
    const canvasId = canvas.id
    const node = (type: 'CHUNK'|'EXTRACT'|'CARD') => prisma.node.create({data:{canvasId,type,params:{},posX:0,posY:0}})
    const chunk = await node('CHUNK'), extract = await node('EXTRACT'), card = await node('CARD')
    const source = await prisma.source.create({data:{nodeId:chunk.id,kind:'PPTX',filename:'audit.pptx',mimeType:'application/octet-stream',pageCount:1}})
    const text = '偶数是能够被二整除的整数。'
    const pages = [{page:1,region:'SLIDE' as const,text},{page:1,region:'NOTES' as const,text:'其它讲稿'}]
    objectKey = pageTextKey(canvasId,source.id)
    await writePageTexts(store,canvasId,source.id,pages)
    const span = await prisma.span.create({data:{sourceId:source.id,page:1,region:'SLIDE',charStart:0,charEnd:text.length,text}})
    await prisma.artifact.create({data:{nodeId:chunk.id,kind:'CHUNKS',hash:'test',structured:{chunkSet:{
      sourceId:source.id,chunks:[{pageStart:1,text,spanIds:[span.id]}]}}}})
    for(const [from,to] of [[chunk,extract],[extract,card]] as const)
      await prisma.edge.create({data:{canvasId,kind:'DERIVED_FROM',fromNodeId:from.id,toNodeId:to.id,fromPort:'out',toPort:'in'}})
    let calls = 0
    const routing = {...TASK_ROUTING,extract:{...TASK_ROUTING.extract,model:'alias',expectedVersion:'snapshot-1'}}
    const llm = createGateway({routing,resolveApiKey:async()=>'test',fetchImpl:async()=>{
      calls++
      const claims = [{chunk:0,name:'偶数',definition:text,quote:text},
        {chunk:0,name:'行星',definition:'鲸鱼是一种行星',quote:'偶数'},
        {chunk:0,name:'偶数',definition:'偶数',quote:'偶数'}]
      return Response.json({model:routing.extract.expectedVersion,usage:{prompt_tokens:25,completion_tokens:9,prompt_cache_hit_tokens:0},
        choices:[{message:{content:JSON.stringify({claims})}}]})
    }})
    const run = (id:string) => executeNode({prisma,objectStore:store,user,llm},id,{dryRun:false})
    const first = await run(extract.id)
    assert.equal((await run(extract.id)).status,'CACHED')
    assert.equal(calls,1)
    routing.extract.expectedVersion='snapshot-2'
    const second = await run(extract.id)
    assert.notEqual(first.fingerprint,second.fingerprint)
    assert.equal(calls,2)
    routing.extract.provider='openai'
    const third = await run(extract.id)
    assert.notEqual(second.fingerprint,third.fingerprint)
    const dbRun = await prisma.run.findUniqueOrThrow({where:{id:third.runId!}})
    assert.equal(dbRun.modelVersion,'snapshot-2')
    assert.equal(dbRun.modelUsed,'openai/alias')
    assert.equal((await prisma.usageRecord.findFirstOrThrow({where:{runId:third.runId}})).provider,'openai')
    await run(card.id)
    const concepts = await prisma.concept.findMany({where:{canvasId},include:{citations:true}})
    assert.equal(concepts.length,1)
    assert.equal(concepts[0]!.status,'VERIFIED')
    assert.equal(concepts[0]!.citations[0]!.quote,text)
    assert.equal((await checkConceptCitations({prisma,objectStore:store},canvasId)).downgraded.length,0)
    await writePageTexts(store,canvasId,source.id,[{...pages[0]!,text:'改变正文'},{...pages[1]!,text}])
    assert.deepEqual((await checkConceptCitations({prisma,objectStore:store},canvasId)).downgraded,[concepts[0]!.id])
  } finally {
    if(objectKey) await store.deleteMany([objectKey])
    await prisma.usageRecord.deleteMany({where:{userId:user.id}})
    await prisma.user.delete({where:{id:user.id}})
    await prisma.$disconnect()
  }
})
