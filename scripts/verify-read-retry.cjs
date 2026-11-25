const {app,BrowserWindow}=require('electron');const http=require('node:http'),path=require('node:path'),fs=require('node:fs'),os=require('node:os'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const root=path.resolve(process.argv[2],'resources/app-build/apps/web/.next/standalone/apps/web');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'sg-read-')));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let fail=true,child,win;
const mock=http.createServer((req,res)=>{
  const p=req.url.split('?')[0];const failed=fail && ['/v1/reviews/due','/v1/reviews/stats','/v1/canvases/qa/groups'].includes(p);
  const data={'/v1/reviews/due':{count:0,items:[]},'/v1/reviews/stats':{newCount:3,dueCount:1},'/v1/canvases':{canvases:[{id:'qa',title:'保留的画布',createdAt:new Date(0)}]},'/v1/canvases/qa':{id:'qa',title:'保留的画布',nodes:[],edges:[]},'/v1/canvases/qa/groups':{groups:[]},'/v1/skills':{skills:[]},'/v1/canvases/qa/concepts':{concepts:[]}};
  data['/v1/canvases/qa/assistant/thread']={revision:0,messages:[]};
  res.writeHead(failed?503:200,{'content-type':'application/json','access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type'});res.end(JSON.stringify(failed?{}:data[p]??{}));
});
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
async function run(){const api=await listen(mock),tmp=http.createServer(),port=await listen(tmp);await new Promise(r=>tmp.close(r));
  const url='http://127.0.0.1:'+port;child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',PORT:String(port),HOSTNAME:'127.0.0.1',STUDYGRAPH_DEV_PAT:'test-only',STUDYGRAPH_API_BASE_URL:'http://127.0.0.1:'+api},windowsHide:true,stdio:'ignore'});
  for(let i=0;i<120;i++){if(await fetch(url).then(r=>r.ok,()=>false))break;await sleep(100)}
  win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});const ev=s=>win.webContents.executeJavaScript(s);
  for(const [route,label,retained] of [['/review','复习队列','今日到期'],['/','复习统计','保留的画布'],['/c/qa','画布分组','保留的画布']]){
    fail=true;await win.loadURL(url+route);await sleep(400);assert.ok((await ev(`document.querySelector('[role="alert"]').innerText`)).includes(label));assert.ok((await ev('document.body.innerText')).includes(retained));assert.equal(await ev(`!!document.querySelector('[data-testid="review-empty"]')`),false);
    fail=false;await ev(`document.querySelector('[role="alert"] button').click()`);for(let i=0;i<60 && await ev(`!!document.querySelector('[role="alert"]')`);i++)await sleep(100);
    assert.equal(await ev(`!!document.querySelector('[role="alert"]')`),false);if(route==='/review')assert.ok(await ev(`!!document.querySelector('[data-testid="review-empty"]')`));
  }console.log('PASS review, home, canvas: HTTP 503, retained sections, retry and genuine empty state');
}
app.whenReady().then(run).then(()=>0,e=>{console.error(e);return 1}).then(code=>{win?.destroy();child?.kill();mock.close();app.exit(code)});
