// 从纯英文临时目录的 Electron 副本运行：electron.exe scripts/verify-group-drag.cjs <发布目录>。
// 只使用新建的临时数据库，避免鼠标调试时误操作学习数据。
const {
  app,
  BrowserWindow
} = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  net = require('node:net');
const {
  spawn
} = require('node:child_process');
const pkg = path.resolve(process.argv[2] || ''),
  resources = path.join(pkg, 'resources'),
  build = path.join(resources, 'app-build');
if (!fs.existsSync(path.join(resources, 'app/pg.cjs'))) throw Error('请指定 StudyGraph 发布目录');
const relativeExe = path.relative(os.tmpdir(), process.execPath);
if (relativeExe.startsWith('..') || path.isAbsolute(relativeExe)) throw Error('请使用临时目录中的 Electron 副本，避免写入真实安装的数据目录标记');
const {
  resolveDatabase
} = require(path.join(resources, 'app/pg.cjs'));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-drag-'));
app.setPath('userData', path.join(base, 'profile'));
process.env.LOCALAPPDATA = base;
process.env.STUDYGRAPH_DATA_DIR = path.join(base, 'db');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const kids = [];
// 回归会主动关闭最后一扇窗口，再开新窗口检查恢复；临时数据库仍由 finally 关闭。
app.on('window-all-closed', () => {});
let db, win;
async function run() {
  db = await resolveDatabase({
    env: {},
    bundleDir: path.join(resources, 'pgsql'),
    migrationsDir: path.join(build, 'packages/db/prisma/migrations'),
    log: console.log
  });
  const ap = await port(),
    wp = await port(),
    api = `http://127.0.0.1:${ap}`,
    web = `http://127.0.0.1:${wp}`;
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    DATABASE_URL: db.databaseUrl,
    STUDYGRAPH_API_BASE_URL: api,
    STUDYGRAPH_DEV_PAT: db.localToken,
    STUDYGRAPH_OBJECT_DIR: path.join(base, 'objects'),
    API_PORT: String(ap),
    PORT: String(wp),
    HOSTNAME: '127.0.0.1',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    DEEPSEEK_API_KEY: ''
  };
  const start = (dir, entry) => {
    const c = spawn(process.execPath, [entry], {
      cwd: dir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'inherit']
    });
    kids.push(c);
  };
  start(build, path.join(build, 'apps/api/dist/apps/api/src/server.js'));
  const webDir = path.join(build, 'apps/web/.next/standalone/apps/web');
  start(webDir, path.join(webDir, 'server.js'));
  for (let i = 0; i < 100; i++) {
    if (await fetch(api + '/health').then(r => r.ok, () => false)) break;
    await sleep(300);
  }
  const req = async (url, body) => {
    const r = await fetch(api + url, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: 'Bearer ' + db.localToken,
        ...(body ? {
          'content-type': 'application/json'
        } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!r.ok) throw Error(r.status + ' ' + (await r.text()));
    return r.json();
  };
  const c = await req('/v1/canvases', {
      title: 'QA canvas'
    }),
    p = '/v1/canvases/' + c.id;
  const node = (type, x, y) => req(p + '/nodes', {
    type,
    posX: x,
    posY: y
  });
  const a = await node('CARD', 50, 70),
    b = await node('CARD', 60, 280),
    t1 = await node('REVIEW', 680, 40),
    t2 = await node('PREREQ', 680, 290),
    ext = await node('CARD', -400, 80);
  const bad = await node('QUIZ', 690, 560),
    third = await node('DEEPEN', -400, 450),
    fourth = await node('LECTURE', 280, 580);
  let g = {
    id: 'pending'
  };
  win = new BrowserWindow({
    width: 1480,
    height: 900,
    // 未激活的隐藏窗口可以收到鼠标模拟，却不会稳定测量节点或派发键盘事件。
    show: true,
    webPreferences: {
      backgroundThrottling: false
    }
  });
  const wc = win.webContents,
    ev = s => wc.executeJavaScript(s),
    group = '[data-testid^="group-node-"]',
    out = group + ' [data-handleid="group-out"]',
    input = group + ' [data-handleid="group-in"]',
    handle = (n, cls) => `[data-nodeid="${n.id}"].${cls}`;
  wc.debugger.attach('1.3');
  win.focus(); wc.focus();
  const shortcutModule=path.join(resources,'app/edit-shortcuts.cjs');
  if(fs.existsSync(shortcutModule))require(shortcutModule).enableEditShortcuts(wc);
  if (process.env.SG_BENCH) {
    const big = await req('/v1/canvases',{title:'QA 100'});
    for(let i=0;i<100;i++) await req('/v1/canvases/'+big.id+'/nodes',{type:'CARD',posX:(i%10)*330,posY:Math.floor(i/10)*170});
    const samples=[];
    for(let i=0;i<4;i++) {
      const start=performance.now(); await win.loadURL(web+'/c/'+big.id+'?sample='+i);
      const sel='.react-flow__node [data-testid="sg-node"]';
      for(let j=0;j<100;j++) {
        const pt=await ev(`(()=>{for(const n of document.querySelectorAll('${sel}')){const b=n.getBoundingClientRect(),x=b.x+8,y=b.y+8;if(n.contains(document.elementFromPoint(x,y)))return {x,y}}})()`);
        if(pt){ for(const type of ['mousePressed','mouseReleased']) await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type,...pt,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1}); if(await ev(`!!document.querySelector('.react-flow__node.selected')`))break; }
        if(j===99)throw Error('benchmark: cannot select node'); await sleep(40);
      }
      samples.push(Math.round(performance.now()-start));
    }
    console.log('100-node canvas ready ms',samples);
    if(process.env.SG_BENCH==='only')return;
  }
  const mouse = (type, pt, down = false) => wc.debugger.sendCommand('Input.dispatchMouseEvent', {
    type,
    ...pt,
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: down ? 1 : 0,
    clickCount: 1
  });
  async function point(sel) {
    return ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const b=e.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return {x,y,hit:document.elementFromPoint(x,y)?.closest(${JSON.stringify(sel)})===e}})()`);
  }
  const at = async sel => {
    const h = await point(sel);
    if (!h?.hit) throw Error('miss: ' + sel + ' ' + JSON.stringify(h));
    return {
      x: h.x,
      y: h.y
    };
  };
  async function drag(label, from, to) {
    const s = await at(from),
      t = await at(to);
    await mouse('mouseMoved', s);
    await mouse('mousePressed', s, true);
    const m = {
      x: (s.x + t.x) / 2,
      y: (s.y + t.y) / 2
    };
    await mouse('mouseMoved', m, true);
    await sleep(90);
    const line = await ev(`!!document.querySelector('.react-flow__connection-path')?.getAttribute('d')`);
    await mouse('mouseMoved', t, true);
    await sleep(80);
    await mouse('mouseReleased', t);
    await sleep(240);
    const state = (await req(p + '/groups')).groups[0];
    console.log(label, JSON.stringify({
      line,
      links: state.usedBy.length,
      members: state.memberIds.length,
      edges: await ev(`document.querySelectorAll('.react-flow__edge').length`)
    }));
    return line;
  }
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(web + '/c/' + c.id);
      if (r.ok) break;
    } catch {}
    await sleep(300);
  }
  await win.loadURL(web + '/c/' + c.id);
  for (let i = 0; i < 100; i++) {
    if ((await point(handle(a, 'source')))?.hit) break;
    await sleep(150);
  }
  await sleep(600);
  const click = async sel => {
    const pt = await at(sel);
    await mouse('mouseMoved', pt);
    await mouse('mousePressed', pt, true);
    await mouse('mouseReleased', pt);
    await sleep(220);
  };
  const box = async id => ev(`(()=>{const r=document.querySelector('[data-id="${id}"]').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
  if(process.env.SG_PERSIST_ONLY) {
    await require('./verify-canvas-persistence.cjs')({api,web,wc,win,ev,req,p,c,a,b,ext,db,mouse,resources}); return;
  }
  if(process.env.SG_EDIT_ONLY){
    const member=await node('CARD',340,260),other=await node('REVIEW',730,710);
    g=await req(p+'/groups',{title:'QA group',nodeIds:[a,b,member,ext].map(n=>n.id),posX:0,posY:0});
    for(const n of [t1,t2,third,fourth,other])await req('/v1/groups/'+g.id+'/link',{nodeId:n.id});
    await verifyEditing({wc,ev,req,p,c,g,a,b,bad,api,web,at,click,db});return;
  }
  const ba = await box(a.id),
    bb = await box(b.id),
    from = {
      x: Math.min(ba.x, bb.x) - 12,
      y: Math.min(ba.y, bb.y) - 12
    },
    to = {
      x: Math.max(ba.x + ba.w, bb.x + bb.w) + 12,
      y: Math.max(ba.y + ba.h, bb.y + bb.h) + 12
    };
  await mouse('mouseMoved', from);
  await mouse('mousePressed', from, true);
  await mouse('mouseMoved', to, true);
  await mouse('mouseReleased', to);
  await sleep(200);
  await click('[data-testid="pack-selected"]');
  await click('[data-testid="group-create-confirm"]');
  await sleep(450);
  g = (await req(p + '/groups')).groups[0];
  if (g.memberIds.length !== 2) throw Error('selection failed');
  console.log('packed via UI; overlay:', await ev(`!!document.querySelector('.react-flow__nodesselection')`));
  async function toggle() {
    const t = await at(`[data-testid="toggle-group-${g.id}"]`);
    await mouse('mousePressed', t, true);
    await mouse('mouseReleased', t);
    await sleep(850);
    console.log('collapsed', await ev(`document.querySelector('${group}').dataset.collapsed`));
  }
  let ok = true;
  ok = (await drag('expanded', out, handle(t1, 'target'))) && ok;
  ok = (await drag('expanded repeat', out, handle(t1, 'target'))) && ok;
  await toggle();
  ok = (await drag('collapsed', out, handle(t2, 'target'))) && ok;
  ok = (await drag('collapsed repeat', out, handle(t2, 'target'))) && ok;
  ok = (await drag('deepen', out, handle(third, 'target'))) && ok;
  ok = (await drag('lecture', out, handle(fourth, 'target'))) && ok;
  ok = (await drag('reject quiz', out, handle(bad, 'target'))) && ok;
  if ((await req(p + '/groups')).groups[0].usedBy.length !== 4) throw Error('invalid target or missing relation');
  async function blank(origin, type, dx) {
    const s = await at(origin),
      t = await ev(`(()=>{const r=document.querySelector('.react-flow__pane').getBoundingClientRect();for(let y=r.bottom-120;y>r.y+100;y-=60)for(let x=r.x+${dx};x<r.right-220;x+=55){if(document.elementFromPoint(x,y)?.classList.contains('react-flow__pane'))return {x,y}}})()`);
    await mouse('mouseMoved', s);
    await mouse('mousePressed', s, true);
    await mouse('mouseMoved', t, true);
    await sleep(80);
    await mouse('mouseReleased', t);
    await sleep(180);
    await click(`[data-testid="search-option-${type}"]`);
    await sleep(320);
    const st = (await req(p + '/groups')).groups[0];
    console.log('blank', type, st.usedBy.length, st.memberIds.length);
  }
  await blank(out, 'DEEPEN', 110);
  await blank(input, 'CARD', 220);
  await toggle();
  ok = (await drag('incoming', handle(ext, 'source'), input)) && ok;
  await win.loadURL(web + '/c/' + c.id);
  await sleep(1200);
  const state = (await req(p + '/groups')).groups[0],
    edgeCount = await ev(`document.querySelectorAll('.react-flow__edge').length`);
  console.log('reload', JSON.stringify({
    links: state.usedBy.length,
    members: state.memberIds.length,
    edgeCount
  }));
  if (!ok || state.usedBy.length !== 5 || state.memberIds.length !== 4 || !state.memberIds.includes(ext.id) || edgeCount !== 5) throw Error('drag assertions failed');
  await verifyEditing({ wc, ev, req, p, c, g, a, b, bad, api, web, at, click, db });
}
async function verifyEditing({ wc, ev, req, p, c, g, a, b, bad, api, web, at, click, db }) {
  const assert = require('node:assert/strict');
  const { PrismaClient } = require('@prisma/client');
  const orm = new PrismaClient({ datasourceUrl: db.databaseUrl });
  async function wait(label, check) {
    for (let i = 0; i < 75; i++) { if (await check()) return; await sleep(80); }
    throw Error(label + ': ' + await ev(`JSON.stringify({focus:document.hasFocus(),state:document.visibilityState,edges:document.querySelectorAll('.react-flow__edge').length,active:document.activeElement.tagName,nodes:[...document.querySelectorAll('.react-flow__node')].slice(0,3).map(n=>[n.style.cssText,n.getBoundingClientRect().toJSON()]),toast:document.querySelector('[data-testid="canvas-toast"]')?.innerText})`));
  }
  async function key(key, code, modifiers = 0) {
    await ev(`window.sgQAKeys=[];window.addEventListener('keydown',e=>window.sgQAKeys.push([e.key,e.code,e.ctrlKey,e.target.tagName,e.isComposing]),{capture:true,once:true})`);
    for (const type of ['keyDown','keyUp']) wc.sendInputEvent({type,keyCode:code.startsWith('Key')?code.slice(3):code,modifiers:[...(modifiers&2?['control']:[]),...(modifiers&8?['shift']:[])]});
    await sleep(220);
    console.log('key',code,await ev(`window.sgQAKeys`),await ev(`document.querySelector('[data-testid="canvas-toast"]')?.innerText`));
  }
  const undo = () => key('z','KeyZ',2), redo = () => key('y','KeyY',2);
  const reload = async () => { await wc.loadURL(web + '/c/' + c.id + '?qa=' + Date.now()); win.show();win.focus();wc.focus();await wait('interactive canvas after navigation',()=>ev(`Array.from(document.querySelectorAll('.react-flow__node')).some(n=>getComputedStyle(n).visibility==='visible')`)); await sleep(320); };
  const tid = id => `[data-testid="${id}"]`;
  const count = async sel => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const nodeSel = id => `.react-flow__node[data-id="${id}"]`;
  async function mouseAt(pt, modifiers=0, button='left') {
    for (const type of ['mousePressed','mouseReleased']) await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...pt, button, modifiers, buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0, clickCount: 1 });
    await sleep(150);
  }
  const linePoint = id => ev(`(()=>{const edge=document.querySelector('.react-flow__edge[data-id="${id}"]'),p=edge?.querySelector('.react-flow__edge-path');if(!p || !/C/i.test(p.getAttribute('d')))return null; for(let i=0.1;i<0.95;i+=0.04){const q=p.getPointAtLength(p.getTotalLength()*i).matrixTransform(p.getScreenCTM());if(document.elementFromPoint(q.x,q.y)?.closest('.react-flow__edge')===edge)return {x:q.x,y:q.y}}return null})()`);
  const groups = () => req(p+'/groups').then(r=>r.groups);
  wc.session.webRequest.onCompleted({urls:[api+'/*']},d=>{if(d.url.includes('/edits'))console.log('edit request',d.method,d.url.slice(api.length),d.statusCode)});
  try {
    const ordinary = await req(p+'/edges', {fromNodeId:a.id,toNodeId:bad.id,fromPort:'out',toPort:'in',kind:'CITES'});
    const run = await orm.run.create({data:{nodeId:a.id,status:'SUCCEEDED'}});
    const artifact = await orm.artifact.create({data:{nodeId:a.id,runId:run.id,kind:'CONCEPT_CARD',structured:{text:'QA'},hash:'qa'}});
    const msg = await orm.nodeMessage.create({data:{nodeId:a.id,role:'user',content:'QA message'}});
    const skill=await orm.skill.findFirstOrThrow({where:{scope:'BUILTIN'}});
    await orm.nodeSkill.create({data:{nodeId:a.id,skillId:skill.id}});
    await reload();
    let curveFailure;
    try {
    await wait('ordinary edge appears',()=>count('.react-flow__edge[data-id="'+ordinary.id+'"]'));
    const pt = await linePoint(ordinary.id);
    if (!pt) console.log('hit trace',await ev(`(()=>{const p=document.querySelector('[data-id="${ordinary.id}"] .react-flow__edge-path');return [p.getAttribute('d'),...Array.from({length:10},(_,i)=>{const q=p.getPointAtLength(p.getTotalLength()*(i+.5)/10).matrixTransform(p.getScreenCTM());return [q.x,q.y,document.elementFromPoint(q.x,q.y)?.outerHTML.slice(0,250)]})]})()`));
    assert.ok(pt,'ordinary curve must be clickable');
    let groupPt;
    for (const id of await ev(`Array.from(document.querySelectorAll('.react-flow__edge[data-id^="glink__"]'),e=>e.dataset.id)`)) { groupPt = await linePoint(id); if(groupPt)break; }
    assert.ok(groupPt,'group curve must be clickable');
    await mouseAt(pt); await mouseAt(groupPt,8);
    assert.equal(await count('.react-flow__edge.selected'),2,'shift-select two curves');
    await mouseAt(pt,0,'right'); await click(tid('menu-delete-edges'));
    await wait('delete two curves',async()=>await count('.react-flow__edge')===4);
    assert.equal((await groups())[0].usedBy.length,4);
    assert.match(await ev(`document.querySelector('[data-testid="canvas-undo"]').title`),/删除 2 条连线/);
    await click(tid('assistant-input'));await wc.insertText('QA');await key('z','KeyZ',2);
    assert.equal(await ev(`document.querySelector('[data-testid="assistant-input"]').value`),'');assert.equal(await count('.react-flow__edge'),4);
    await reload(); console.log('undo target',await ev(`document.activeElement.outerHTML.slice(0,140)`)); await undo(); await wait('undo mixed curves across reload',async()=>await count('.react-flow__edge')===6);
    assert.equal((await orm.edge.findUniqueOrThrow({where:{id:ordinary.id}})).kind,'CITES');
    await redo(); await wait('redo mixed curves',async()=>await count('.react-flow__edge')===4); await undo();
    await wait('restore both curves',async()=>await count('.react-flow__edge')===6);
    await mouseAt(await linePoint(ordinary.id));await key('a','KeyA',2);assert.equal(await count('.react-flow__edge.selected'),6);
    await key('Escape','Escape');assert.equal(await count('.react-flow__edge.selected'),0);
    await mouseAt(await linePoint(ordinary.id));await key('Backspace','Backspace');await wait('keyboard delete edge',async()=>await count('.react-flow__edge')===5);
    await undo();await wait('restore keyboard delete',async()=>await count('.react-flow__edge')===6);
    console.log('PASS real mouse: mixed curve selection, context delete, persisted undo/redo');
    } catch(error) {
      curveFailure=error; console.error('curve suite:', error.message.split(':')[0]);
      if(!await orm.edge.findUnique({where:{id:ordinary.id}}))await req(p+'/edits/undo',{});
      await reload();
    }

    const groupRow = () => orm.nodeGroup.findUnique({where:{id:g.id}});
    const nodeRow = () => orm.node.findUnique({where:{id:a.id}});
    const orig = await nodeRow(), groupBefore = (await groups())[0];
    const cardPoint = await ev(`(()=>{const n=document.querySelector('${nodeSel(a.id)} [data-testid="sg-node"]'),b=n.getBoundingClientRect();for (let y=b.y+3;y<b.bottom;y+=5)for(let x=b.x+5;x<b.right;x+=8){const e=document.elementFromPoint(x,y);if(e && n.contains(e) && !e.closest('button,input,textarea,.react-flow__handle'))return {x,y}}})()`);
    if(!cardPoint)console.log('node occlusion',await ev(`(()=>{const n=document.querySelector('${nodeSel(a.id)} [data-testid="sg-node"]'),r=n.getBoundingClientRect();return [r.toJSON(),document.elementsFromPoint(r.x+r.width/2,r.y+r.height/2).slice(0,8).map(e=>[e.tagName,e.className?.baseVal??e.className,e.getAttribute('data-testid')]) ]})()`));
    assert.ok(cardPoint,'exposed part of node card'); await mouseAt(cardPoint); await key('Delete','Delete'); await click(tid('prompt-dialog-ok'));
    await wait('UI node delete',async()=>!await nodeRow());
    assert.equal(await orm.artifact.count({where:{id:artifact.id}}),0);
    await click(tid('group-menu-'+g.id)); await click(tid('group-menu-unpack')); await click(tid('prompt-dialog-ok'));
    await wait('UI unpack',async()=>!await groupRow()); assert.ok(await orm.node.findUnique({where:{id:b.id}}));
    await reload(); await undo(); await wait('restore group',async()=>!!await groupRow());
    assert.equal((await groups())[0].memberIds.length,3);
    await undo(); await wait('restore node',async()=>!!await nodeRow());
    assert.deepEqual(await nodeRow(),orig);
    assert.deepEqual(await orm.nodeMessage.findUnique({where:{id:msg.id}}),msg);
    assert.deepEqual(await orm.artifact.findUnique({where:{id:artifact.id}}),artifact);
    assert.deepEqual(await orm.run.findUnique({where:{id:run.id}}),run);
    assert.deepEqual((await req(p)).nodes.find(n=>n.id===a.id).skillNames,[skill.name]);
    assert.deepEqual((await groups())[0].memberIds.sort(),groupBefore.memberIds.sort());
    await key('Z','KeyZ',10); await wait('redo node',async()=>!await nodeRow());
    await redo(); await wait('redo unpack',async()=>!await groupRow());
    await undo(); await undo(); await wait('restore interleaved history',async()=>!!await nodeRow());
    await click(tid('toggle-group-'+g.id)); await sleep(500);
    await click(tid('group-menu-'+g.id)); await click(tid('group-menu-delete')); await click(tid('prompt-dialog-ok'));
    await wait('delete entire group',async()=>!await groupRow() && !await nodeRow());
    await undo(); await wait('restore collapsed group',async()=>!!(await groupRow())?.collapsed);
    assert.deepEqual(await nodeRow(),orig); assert.equal((await groups())[0].usedBy.length,5);
    assert.ok(await orm.edge.findUnique({where:{id:ordinary.id}}));
    console.log('PASS real keyboard/menu: node, unpack, whole group, identity, membership, messages, runs and artifacts');

    const edit = (mode,body={}) => req(p+'/edits/'+mode,body);
    await orm.node.update({where:{id:a.id},data:{title:'QA changed after undo'}});
    await assert.rejects(edit('redo'),/409/); assert.ok(await groupRow());
    await assert.rejects(edit('delete',{nodes:[a.id,'wrong-canvas-or-missing']}),/409/); assert.ok(await nodeRow());
    const other=await req('/v1/canvases',{title:'QA separate canvas'}), foreign=await req('/v1/canvases/'+other.id+'/nodes',{type:'CARD',posX:0,posY:0});
    await assert.rejects(edit('delete',{nodes:[a.id,foreign.id]}),/409/);assert.ok(await nodeRow());assert.ok(await orm.node.findUnique({where:{id:foreign.id}}));
    await orm.run.update({where:{id:run.id},data:{status:'RUNNING'}});
    await assert.rejects(edit('delete',{nodes:[a.id,b.id]}),/409/); assert.ok(await nodeRow());
    await orm.run.update({where:{id:run.id},data:{status:'SUCCEEDED'}});
    await edit('delete',{nodes:[a.id,b.id]}); assert.equal(await nodeRow(),null);
    assert.equal((await edit('redo')).unchanged,true); await edit('undo');
    assert.equal((await groups())[0].memberIds.length,4); assert.ok(await orm.node.findUnique({where:{id:b.id}}));
    console.log('PASS atomic batch delete, redo branch invalidation, conflict and rollback protections');
    if(curveFailure)throw curveFailure;
  } finally { await orm.$disconnect(); }
}
app.whenReady().then(run).then(() => 0, e => {
  console.error(e);
  return 1;
}).then(async code => {
  for (const c of kids) c.kill();
  if (db) await db.stop();
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(code);
});
