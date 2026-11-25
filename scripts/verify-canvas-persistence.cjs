// 复用 verify-group-drag 的隔离服务器、临时库和可见 Electron 窗口。
const assert = require('node:assert/strict'), path = require('node:path');
const sleep = ms => new Promise(r => setTimeout(r,ms));
module.exports = async function({api,web,wc,win,ev,req,p,c,a,b,ext,db,mouse,resources}) {
  const orm = new (require('@prisma/client').PrismaClient)({datasourceUrl:db.databaseUrl});
  const tid = id => `[data-testid="${id}"]`;
  const click = id => ev(`document.querySelector(${JSON.stringify(tid(id))}).click()`);
  const fill = (id,value) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(tid(id))});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const wait = async (label, fn) => { for(let i=0;i<110;i++){if(await fn())return;await sleep(80)}throw Error(label) };
  const visit = async () => {await win.loadURL(web+'/c/'+c.id); await wait('canvas did not hydrate',()=>ev(`!!document.querySelector('[data-testid^="toggle-group-"]')`));};
  try {
    const g = await req(p+'/groups',{title:'布局回归',nodeIds:[a.id,b.id,ext.id],posX:110,posY:150});
    await orm.artifact.create({data:{nodeId:a.id,kind:'CONCEPT_CARD',hash:'qa',structured:{cards:{cards:Array.from({length:8},(_,i)=>({name:'概念'+i,definition:'用于测量这张长卡的真实上下边界。'.repeat(6)}))}}}});
    const rows = () => orm.node.findMany({where:{id:{in:[a.id,b.id,ext.id]}},select:{id:true,posX:true,posY:true},orderBy:{id:'asc'}});
    const group = () => orm.nodeGroup.findUniqueOrThrow({where:{id:g.id}});
    const original = await rows();
    await ev(`sessionStorage.setItem('studygraph:assistant:${c.id}',JSON.stringify([{id:'legacy',role:'user',text:'旧对话'}]))`);
    await visit();
    const geometry = () => ev(`(()=>{const f=document.querySelector('${tid('group-node-'+g.id)}')?.getBoundingClientRect(), head=document.querySelector('${tid('toggle-group-'+g.id)}')?.parentElement.getBoundingClientRect();if(!f||!head)return null;const cards=${JSON.stringify([a.id,b.id,ext.id])}.map(id=>document.querySelector('[data-id="'+id+'"]')?.getBoundingClientRect());if(cards.some(r=>!r))return null;return {clearance:Math.min(...cards.flatMap(r=>[r.left-f.left,f.right-r.right,f.bottom-r.bottom,r.top-head.bottom])),height:document.querySelector('[data-id="${a.id}"]').offsetHeight}})()`);
    if (!process.env.SG_BASELINE_GEOMETRY) await wait('measured frame never enclosed the cards',async()=>(await geometry())?.clearance>0);
    await sleep(500); const geom = await geometry(); console.log('geometry',geom);
    if(geom.clearance<=0) console.log('bounds',await ev(`JSON.stringify(Array.from(document.querySelectorAll('.react-flow__node,[data-testid^="group-node-"],[data-testid^="toggle-group-"]'),n=>[n.getAttribute('data-id')??n.dataset.testid,n.style.transform,n.offsetWidth,n.offsetHeight,n.getBoundingClientRect().toJSON()]))`));
    if(process.env.SG_BASELINE_GEOMETRY) {assert.ok(geom.clearance < 0);return;}
    assert.ok(geom.clearance>0 && geom.height>220);
    const toggle=()=>click('toggle-group-'+g.id);
    const move=async()=>{
      const pt=await ev(`(()=>{const r=document.querySelector('${tid('toggle-group-'+g.id)}').nextElementSibling.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      const before=await rows(), old=await group(); await mouse('mouseMoved',pt);await mouse('mousePressed',pt,true);
      await mouse('mouseMoved',{x:pt.x+11,y:pt.y+4},true);await sleep(70);await mouse('mouseMoved',{x:pt.x+45,y:pt.y+26},true);await mouse('mouseReleased',{x:pt.x+45,y:pt.y+26});
      await wait('drag group did not commit',async()=>(await group()).posX!==old.posX);
      const after=await rows(), newer=await group(); assert.ok(newer.posX>old.posX && newer.posY>old.posY);
      after.forEach((n,i)=>{assert.equal(n.posX-before[i].posX,newer.posX-old.posX);assert.equal(n.posY-before[i].posY,newer.posY-old.posY)});
    };
    await move(); await toggle(); await sleep(420);await move(); const moved=await rows();
    await toggle(); await click('back-link'); await wait('return not completed',()=>ev(`location.pathname==='/'`)); await visit();
    assert.equal((await group()).collapsed,false);assert.deepEqual(await rows(),moved); assert.ok((await geometry()).clearance>0);
    console.log('PASS measured frame, two drag states, leave during expand; member offsets preserved');
    const thread=()=>req(p+'/assistant/thread'); await wait('legacy import',async()=>(await thread()).messages.length===1);
    await fill('assistant-input','测试持久化');await click('assistant-send');await wait('assistant response persisted',async()=>(await thread()).messages.length===3);
    // 服务端已经提交，但渲染进程第一次收不到应答。退出重试不能多写一轮。
    await ev(`{const f=window.fetch;let lost=true;window.fetch=async (...args)=>{const r=await f(...args);if(lost && String(args[0]).endsWith('/nodes/${b.id}/chat')){lost=false;throw Error('QA lost ack')}return r}};void 0`);
    await click('chat-node-'+b.id);await fill('node-chat-input','记住这个问题');await wait('node chat ready',()=>ev(`!document.querySelector('${tid('node-chat-send')}').disabled`));await click('node-chat-send');
    await wait('node reply',async()=>await orm.nodeMessage.count({where:{nodeId:b.id}})===2);await click('close-node-chat');
    await fill('param-'+b.id+'-prompt','保留未手动提交的提示词');await toggle();
    await ev(`window.realFetch=window.fetch;window.fetch=(url,opt)=>String(url).endsWith('/nodes/${b.id}')&&opt?.method==='PATCH'?Promise.resolve(new Response('{}',{status:503})):window.realFetch(url,opt);void 0`);
    await click('back-link'); await wait('no error dialog',()=>ev(`!!document.querySelector('dialog [role="alert"]')`));
    await ev(`Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='留在画布').click()`);
    assert.equal(await ev('location.pathname'),'/c/'+c.id);
    const {installSaveBeforeClose}=require(path.join(resources,'app/save-before-close.cjs'));
    installSaveBeforeClose(win,require('electron').dialog,()=>{});win.close();win.close();
    await wait('window did not block on error',()=>ev(`!!document.querySelector('dialog [role="alert"]')`));
    await ev(`window.fetch=window.realFetch;Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='重试保存').click()`);
    await wait('window did not close',()=>win.isDestroyed());
    assert.equal((await orm.node.findUniqueOrThrow({where:{id:b.id}})).params.prompt,'保留未手动提交的提示词');
    assert.equal((await group()).collapsed,true);assert.deepEqual(await rows(),moved); assert.equal((await thread()).messages.length,3);
    const nw=new (require('electron').BrowserWindow)({show:true,webPreferences:{backgroundThrottling:false}});
    try{await nw.loadURL(web+'/c/'+c.id);const e=s=>nw.webContents.executeJavaScript(s);
      await wait('assistant not restored',()=>e(`document.querySelectorAll('[data-testid^="assistant-msg-"]').length===3`));
      await e(`document.querySelector('${tid('toggle-group-'+g.id)}').click()`);await sleep(450);await e(`document.querySelector('${tid('chat-node-'+b.id)}').click()`);
      await wait('node messages not restored',()=>e(`document.querySelector('${tid('node-chat-user')}')?.innerText==='记住这个问题'`));
      assert.equal(await e(`document.querySelector('${tid('param-'+b.id+'-prompt')}').value`),'保留未手动提交的提示词');
      await e(`document.querySelector('${tid('clear-assistant')}').click()`);await wait('clear did not persist',async()=>(await thread()).messages.length===0);
      assert.equal(await orm.nodeMessage.count({where:{nodeId:b.id}}),2);
      if(process.env.SG_TEST_ARRANGE){
        const outside=await orm.node.findMany({where:{canvasId:c.id,id:{notIn:g.memberIds??moved.map(n=>n.id)}},select:{id:true,posX:true,posY:true},orderBy:{id:'asc'}});
        await e(`document.querySelector('${tid('group-menu-'+g.id)}').click()`);await e(`document.querySelector('${tid('group-menu-arrange')}').click()`);await e(`document.querySelector('${tid('prompt-dialog-ok')}').click()`);
        await wait('arrangement not persisted',async()=>JSON.stringify(await rows())!==JSON.stringify(moved));
        assert.deepEqual(await orm.node.findMany({where:{id:{in:outside.map(n=>n.id)}},select:{id:true,posX:true,posY:true},orderBy:{id:'asc'}}),outside);
        const rects=await e(`(${JSON.stringify(moved.map(n=>n.id))}).map(id=>document.querySelector('[data-id="'+id+'"]').getBoundingClientRect().toJSON())`);
        rects.forEach((a,i)=>rects.slice(i+1).forEach(b=>assert.ok(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top)));
        console.log('PASS group-only arrange: real cards disjoint, outside nodes unchanged');
      }
    }finally{nw.destroy()}
    console.log('PASS legacy assistant import, two chats, failed navigation, duplicate close, retry, hidden draft, fresh window and isolated clear');
    console.log('QA restart fixture',JSON.stringify({db:db.baseDir,canvas:c.id}));
  }finally{await orm.$disconnect()}
};
