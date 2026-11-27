import test from 'node:test'
import assert from 'node:assert/strict'
import { declaredLevels, listedReasoningLevels, reasoningLevels, nodeModelTask } from '../../../../packages/contracts/src/reasoning.ts'
import { createGateway } from '../../src/llm/gateway.ts'
import type { AgentMessage } from '../../src/llm/types.ts'
import type { ResolvedTarget } from '../../src/llm/credentials.ts'

const user = { id: 'test', canvasId: 'canvas', email: '', displayName: '' }
const counts = { prompt_tokens: 9, completion_tokens: 4 }
const messages = [{ role: 'user' as const, content: '问' }]

test('同厂商不同型号分别声明原生档位；未知型号和端点声明优先', () => {
  assert.deepEqual(reasoningLevels('gpt-5.1', 'OPENAI'), ['none', 'low', 'medium', 'high'])
  assert.deepEqual(reasoningLevels('gpt-5.2-2025-12-11', 'OPENAI'), ['none', 'low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(reasoningLevels('gpt-5.2-private', 'OPENAI'), [])
  assert.deepEqual(reasoningLevels('deepseek-flash', 'OPENAI'), ['none', 'low', 'high', 'max'])
  assert.deepEqual(reasoningLevels('claude-opus-4-6', 'ANTHROPIC'), ['low', 'medium', 'high', 'max'])
  assert.deepEqual(reasoningLevels('gpt-5.2', 'OPENAI', { reasoningLevels: [] }), [])
  assert.deepEqual(declaredLevels([{effort:'quick'}, {effort:'thorough'}]), ['quick','thorough'])
  assert.equal(declaredLevels(['high', null]), undefined)
  assert.deepEqual(listedReasoningLevels('deepseek-flash', { effort:{supported_levels:['low','max']} }), ['none','low','max'])
  assert.deepEqual(listedReasoningLevels('private', { capabilities:{effort:{max:{supported:true},xhigh:{supported:false},low:{supported:true}}} }), ['low','max'])
  assert.equal(nodeModelTask('GRADE'), 'check'); assert.equal(nodeModelTask('CHUNK'), undefined)
})

test('固定一次操作的模型与档位；普通请求、流式重试和工具轮次发送相同设置', async () => {
  let model = 'gpt-5.2', effort: string | undefined = 'xhigh'
  const seen: Record<string, any>[] = []
  const gateway = createGateway({ resolveApiKey: async () => null,
    resolveTarget: async () => ({ apiKey: 'test', model, baseUrl:'http://local/v1', protocol:'OPENAI', providerSlug:'relay', source:'byok', providerName:'test', fromPreference:true }),
    resolveEffort: async () => effort,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); seen.push(body)
      if (!body.stream) return new Response('stream_required', {status:400})
      const chunk = { model:body.model, choices:[{delta:{content:'{}'},finish_reason:'stop'}], usage:counts }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n`, {headers:{'content-type':'text/event-stream'}})
    } })
  const once = await gateway.forOperation!('assistant', user, 'assistant')
  model = 'other'; effort = undefined
  const req = { user, taskType:'assistant' as const, messages }
  await once.complete(req); await once.chatWithTools({...req,tools:[]}); await once.chatWithTools({...req,tools:[]})
  assert.equal(seen.length, 6)
  assert.ok(seen.every(b => b.model === 'gpt-5.2' && b.reasoning_effort === 'xhigh' && b.max_completion_tokens))
  await (await gateway.forOperation!('assistant', user, 'assistant')).complete(req)
  assert.equal(seen.at(-1)?.model, 'other'); assert.ok(!('reasoning_effort' in seen.at(-1)!))
})

test('DeepSeek 保留工具轮思考原文；关闭思考使用 disabled', async () => {
  const seen: any[] = [], original = '  ' + '理由'.repeat(5000)
  let effort = 'high'
  const gw = createGateway({resolveApiKey:async()=>null, resolveEffort:async()=>effort,
    resolveTarget:async()=>({model:'deepseek-flash',providerSlug:'relay',protocol:'OPENAI',apiKey:'test',baseUrl:'http://local'} as ResolvedTarget),
    fetchImpl:async(_u,init)=>{seen.push(JSON.parse(String(init?.body)));return Response.json({model:'deepseek-flash',usage:counts,choices:[{message:{content:'',reasoning_content:original,tool_calls:[{id:'t',function:{name:'read',arguments:'{}'}}]}}]})}})
  const req = {user, taskType:'assistant' as const,tools:[],messages}
  const once = await gw.forOperation!('assistant',user,'assistant')
  const result = await once.chatWithTools(req)
  const next: AgentMessage = {role:'assistant',content:'',toolCalls:result.toolCalls,reasoningContent:result.reasoningContent}
  await once.chatWithTools({...req,messages:[...messages,next]})
  assert.equal(seen[1].messages[1].reasoning_content, original); assert.deepEqual(seen[1].thinking,{type:'enabled'})
  effort='none';await (await gw.forOperation!('assistant',user,'assistant')).chatWithTools(req)
  assert.deepEqual(seen[2].thinking,{type:'disabled'});assert.equal(seen[2].reasoning_effort,undefined)
})

test('Claude 结构化输出和工具轮次按原生协议调强度，保存思考签名', async () => {
  const seen: any[] = []
  const blocks = [{type:'thinking',thinking:'分析',signature:'signed'},{type:'tool_use',id:'tool',name:'emit_result',input:{a:1}}]
  const gw = createGateway({resolveApiKey:async()=>null, resolveEffort:async()=>'max',
    resolveTarget:async()=>({model:'claude-opus-4-6',providerSlug:'relay',protocol:'ANTHROPIC',apiKey:'test',baseUrl:'http://local'} as ResolvedTarget),
    fetchImpl:async(_u,init)=>{seen.push(JSON.parse(String(init?.body)));return Response.json({model:'claude-opus-4-6',usage:{input_tokens:9,output_tokens:4},content:blocks})}})
  const once = await gw.forOperation!('method',user,'group-name')
  const req = {user,taskType:'method' as const,messages}
  assert.deepEqual((await once.complete({...req,jsonSchema:{type:'object'}})).data,{a:1})
  assert.deepEqual(seen[0].tool_choice,{type:'auto'})
  const result = await once.chatWithTools({...req,tools:[]})
  await once.chatWithTools({...req,tools:[],messages:[...messages,{role:'assistant',content:'',nativeContent:result.nativeContent},{role:'tool',toolCallId:'tool',content:'{}'}]})
  assert.deepEqual(seen[2].messages[1].content,blocks)
  assert.ok(seen.every(b => b.output_config.effort === 'max' && b.thinking.type === 'adaptive'))
})
