// 用临时 Electron 副本运行；真实升级文件不改动，只在临时副本里断开测试连接。
const {app} = require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {PrismaClient}=require('@prisma/client');
const base=fs.mkdtempSync(path.join(os.tmpdir(),'sg-upgrade-'));
if(path.relative(os.tmpdir(),process.execPath).startsWith('..'))throw Error('请从临时 Electron 副本运行');
app.setPath('userData',path.join(base,'profile'));process.env.LOCALAPPDATA=base;process.env.STUDYGRAPH_DATA_DIR=path.join(base,'db');
const res=path.resolve(process.argv[2],'resources'),old=path.resolve(process.argv[3],'resources');
const migrations=r=>path.join(r,'app-build/packages/db/prisma/migrations');
const start=(r,dir)=>require(path.join(r,'app/pg.cjs')).resolveDatabase({env:{},bundleDir:path.join(r,'pgsql'),migrationsDir:dir,log:console.log});
let db,orm;
async function close(){if(orm){await orm.$disconnect();orm=null}if(db){await db.stop();db=null}}
async function test(){
  db=await start(old,migrations(old));orm=new PrismaClient({datasourceUrl:db.databaseUrl});
  const owner=await orm.user.findFirstOrThrow();const c=await orm.canvas.create({data:{ownerId:owner.id,title:'旧版测试画布'}});
  const n=await orm.node.create({data:{canvasId:c.id,type:'SOURCE',title:'旧课件',posX:123,posY:456}});
  const file=path.join(base,'lesson.txt');fs.writeFileSync(file,'旧课件内容');
  const artifact=await orm.artifact.create({data:{nodeId:n.id,kind:'SOURCE_TEXT',s3Key:file,structured:{text:'旧课件内容'},hash:'qa'}});
  await close();
  const bad=path.join(base,'migrations');fs.cpSync(migrations(res),bad,{recursive:true});
  const migration=fs.readdirSync(bad).filter(n=>!fs.existsSync(path.join(migrations(old),n)) && fs.existsSync(path.join(bad,n,'migration.sql'))).sort()[0];
  assert.ok(migration,'没有新增迁移');
  fs.appendFileSync(path.join(bad,migration,'migration.sql'),'\nSELECT pg_terminate_backend(pg_backend_pid());\n');
  await assert.rejects(start(res,bad),new RegExp(migration));
  for(let i=0;i<2;i++){
    db=await start(res,migrations(res));orm=new PrismaClient({datasourceUrl:db.databaseUrl});
    assert.deepEqual(await orm.node.findUnique({where:{id:n.id}}),n);
    assert.deepEqual(await orm.artifact.findUnique({where:{id:artifact.id}}),artifact);assert.equal(fs.readFileSync(file,'utf8'),'旧课件内容');
    const [entry]=await orm.$queryRaw`SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name=${migration} AND finished_at IS NOT NULL`;
    assert.equal(entry.n,1);await close();
  }
  console.log('PASS interrupted real upgrade, original data and single migration after two restarts');
}
app.whenReady().then(test).then(()=>0,e=>{console.error(e);return 1}).then(async code=>{await close();app.exit(code)});
