// 本轮仅授权这十份文件的提取文字；两个旧版请求的实际用量已计入预算。
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {prisma} from '../packages/db/src/index.ts'
import {extractPptx} from '../apps/api/src/storage/pptx.ts'
import {registerBuiltinExecutors} from '../apps/api/src/nodes/executors/index.ts'
import {executeNode} from '../apps/api/src/nodes/execute.ts'
import {createObjectStore} from '../apps/api/src/storage/object-store.ts'
import {createGateway} from '../apps/api/src/llm/gateway.ts'
import {checkConceptCitations} from '../apps/api/src/spans/citation-integrity.ts'

const manifest = [
  [
    "第三章/ch3-1（1）.pptx",
    "1dcd582fc85c95c4516ecfa48c2edd73cb3feeb379716418319d4de192865f2c"
  ],
  [
    "第三章/ch3-1（2）.pptx",
    "fd689c1f80b095e3edcdc7462a945265a927b9d7ab0a9173a846557404bee838"
  ],
  [
    "第三章/ch3-2.pptx",
    "231215f4fac53d651d8a03851204b2e42395796d10f7f8cd2c417b544fe610c4"
  ],
  [
    "第三章/ch3-3.pptx",
    "9aa1fda0d416b1239136db3d7afa5d443ac070f01d925e39bf8bfe3e08d35508"
  ],
  [
    "第三章/ch3-4.pptx",
    "a69f7fd0ce02925711887196d6514e8f371cda8d1ee3753d5433eda1b3c323dc"
  ],
  [
    "第四章/ch4-1.pptx",
    "95fafec00d5bd126fe6e94ad82cbfd80a00cafb294b00d6311dab29645b095b8"
  ],
  [
    "第四章/ch4-2.pptx",
    "503cdf2615e960335f9591a104569c1127b43fab37fb5899ff4f1659adb719cb"
  ],
  [
    "第四章/ch4-3.pptx",
    "0cc90a268cfad1bba78043ab7081c1be08330bc4b31c23daaaa1bbc8d47b6927"
  ],
  [
    "第四章/ch4-4.pptx",
    "000de9d11ad737ed5ad1dd954bed49be286b195e4481137c56b0474c61732be8"
  ],
  [
    "第四章/ch4-5.pptx",
    "7fca5925e1db94e4ba91929ea553272e8cbe707cbf872c4f95c6f92e4becfe31"
  ]
]
const materials=manifest.map(([name,hash])=>{
  const file=path.resolve('课件',name), bytes=fs.readFileSync(file)
  if(createHash('sha256').update(bytes).digest('hex')!==hash) throw Error('课件内容发生变化：'+name)
  return {file,hash,text:extractPptx(bytes).pages.map(p=>p.text).join('\n')}
})
if(process.argv.includes('--preflight')){
  console.log('Authorized files verified:',materials.length)
  console.log('Remaining input/output tokens:',60000-2838,20000-786)
  process.exit(0)
}
const key=process.env.DEEPSEEK_API_KEY?.trim()
if (!key) throw Error('请在本机为本进程注入 DEEPSEEK_API_KEY')
const previousPath='docs/交付/实调证据-011-DeepSeek.jsonl'
const recover=process.argv.includes('--recover-a1')
let heldIn=0,heldOut=0
if(recover){
  const rows=fs.readFileSync(previousPath,'utf8').trim().split(/\r?\n/).map(s=>JSON.parse(s))
  if(rows.length!==3 || rows[0].event!=='opening' || rows[0].input!==2838 || rows[0].output!==786 ||
     rows[1].event!=='canvas' || rows[2].event!=='reserve' || rows[2].label!=='A1' ||
     rows[2].inputBound!==4341 || rows[2].outputBound!==2048) throw Error('旧账本状态已变，不能重复执行')
  heldIn=rows[2].inputBound;heldOut=rows[2].outputBound
}
const evidence=fs.openSync(recover?'docs/交付/实调证据-013-DeepSeek续跑.jsonl':previousPath,'wx')
const log=(event)=>{const line=JSON.stringify(event);fs.writeSync(evidence,line+'\n');fs.fsyncSync(evidence);console.log(line)}
let input=2838+heldIn, output=786+heldOut, label=''
log({event:'opening',input,output,heldIn,heldOut,inputLimit:60000,outputLimit:20000})
const gateway=createGateway({resolveApiKey:async provider=>provider==='deepseek'?key:null,fetchImpl:async(url,init)=>{
  if(String(url)!=='https://api.deepseek.com/chat/completions')throw Error('非授权端点')
  const body=JSON.parse(init.body)
  body.max_tokens=Math.min(body.max_tokens,20000-output)
  const payload=JSON.stringify(body)
  // UTF-8 字节数加协议余量，作为单次输入的保守上界。
  const reserve=Buffer.byteLength(payload)+1024
  if(input+reserve>60000||body.max_tokens<1)throw Error('剩余额度不足，停止发送')
  log({event:'reserve',label,inputBound:reserve,outputBound:body.max_tokens})
  const res=await fetch(url,{...init,body:payload,redirect:'error',signal:AbortSignal.timeout(120000)})
  if(!res.ok)throw Error('DeepSeek HTTP '+res.status)
  const data=await res.clone().json(),u=data.usage
  if(![u?.prompt_tokens,u?.completion_tokens,u?.prompt_cache_hit_tokens].every(x=>Number.isSafeInteger(x)&&x>=0))throw Error('计量不完整，停止发送')
  input+=u.prompt_tokens;output+=u.completion_tokens
  log({event:'usage',label,model:data.model,tokensIn:u.prompt_tokens,tokensOut:u.completion_tokens,cachedTokens:u.prompt_cache_hit_tokens,input,output})
  if(u.prompt_tokens>reserve||u.completion_tokens>body.max_tokens)throw Error('用量超过预留，停止发送')
  return res
}})
try{
 const original=await prisma.canvas.findUniqueOrThrow({where:{id:'cmwnemx2x001iq5l4jgx1k4sp'},include:{owner:true}})
 const user=original.owner
 const canvas=await prisma.canvas.create({data:{ownerId:user.id,title:'011 十份课件实调'}})
 log({event:'canvas',id:canvas.id})
 const e=process.env,objectStore=createObjectStore({endpoint:e.S3_ENDPOINT,bucket:e.S3_BUCKET,region:e.S3_REGION,accessKeyId:e.S3_ACCESS_KEY_ID,secretAccessKey:e.S3_SECRET_ACCESS_KEY})
 registerBuiltinExecutors()
 for(const [tag,material] of [['A1',materials[2]],['A2',materials[2]],['B1',materials[8]]]){
   label=tag
   await gateway.complete({taskType:'extract',messages:[{role:'user',content:'用一个 JSON 对象返回课件主题。'}],jsonSchema:{type:'object',properties:{topic:{type:'string'}}},cachePrefix:{key:material.hash,text:material.text},user})
 }
 for(const material of materials){
   label=path.basename(material.file)
   let prev=null
   for(const type of ['SOURCE','CHUNK','EXTRACT','CARD']){
     const params=type==='SOURCE'?{localPath:material.file}:type==='EXTRACT'?{batchSize:100}:{}
     const node=await prisma.node.create({data:{canvasId:canvas.id,type,params,posX:0,posY:0}})
     if(prev)await prisma.edge.create({data:{canvasId:canvas.id,kind:'DERIVED_FROM',fromNodeId:prev,toNodeId:node.id,fromPort:'out',toPort:'in'}})
     if(type==='EXTRACT'){
       const art=await prisma.artifact.findFirstOrThrow({where:{nodeId:prev},orderBy:{createdAt:'desc'}})
       const cs=art.structured.chunkSet
       const src=await prisma.source.findUniqueOrThrow({where:{id:cs.sourceId}})
       if(src.checksum!==material.hash||cs.chunks.some(c=>!material.text.includes(c.text)))throw Error('切片与授权材料不一致')
     }
     const run=await executeNode({prisma,objectStore,llm:gateway,user},node.id,{dryRun:false})
     const art=await prisma.artifact.findFirstOrThrow({where:{runId:run.runId}})
     const claims=art.structured.conceptClaims?.claims
     log({event:'run',label,type,runId:run.runId,status:run.status,claims:claims?.length,quotes:claims?.filter(c=>c.quote).length,verified:art.structured.cards?.verified})
     prev=node.id
   }
 }
 const audit=await checkConceptCitations({prisma,objectStore},canvas.id)
 const counts=await prisma.concept.groupBy({by:['status'],where:{canvasId:canvas.id},_count:true})
 log({event:'completed',input,output,counts,audit})
}finally{fs.closeSync(evidence);await prisma.$disconnect()}
