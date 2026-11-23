// StudyGraph 桌面客户端主进程。
//
// 启动顺序：
//   1. 找两个空闲端口（API / Web），避免与本机 Docker 或开发服务冲突
//   2. 启动 API（编译产物 apps/api/dist/server.js）
//   3. 启动 Web（Next standalone 的 server.js）
//   4. 两边都真正能响应后才开窗口 —— 不等就开窗口会白屏，用户以为软件坏了
//   5. 退出时把子进程一起收掉，不留孤儿
//
// 两个必须遵守的约束（都是实测踩出来的）：
//   · 不能用 `--experimental-strip-types` 直接跑 .ts：Electron 内置 Node 20 没有这个开关，
//     主进程会以 "bad option" 静默失败。桌面版一律跑编译后的 .js。
//   · 端口不能写死：学生机器上可能已经有别的东西占着 3000/3001。
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const { resolveDatabase, freePort } = require('./pg.cjs')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..', '..')
const IS_PACKAGED = app.isPackaged
const children = []

const log = (...args) => console.log('[studygraph-desktop]', ...args)

/** 内置库的句柄；退出时要同步停掉，否则残留 postmaster.pid */
let database = null
let shuttingDown = false

async function waitForHttp(url, { timeoutMs = 90000, intervalMs = 400 } = {}) {
  const started = Date.now()
  let last = ''
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) })
      if (response.status < 500) return true
      last = `HTTP ${response.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`等待 ${url} 超时（${timeoutMs}ms）：${last}`)
}

/**
 * 配置来源（按优先级，后者覆盖前者）：
 *   1. 安装目录旁的 .env（便携部署：用户把程序和配置放一起）
 *   2. 用户数据目录的 .env（%APPDATA%/StudyGraph/.env，卸载不丢）
 * 打包后**不读开发者仓库的 .env** —— 用户机器上没有那个文件。
 */
function readEnvFile() {
  const candidates = IS_PACKAGED
    ? [path.join(path.dirname(process.execPath), '.env'), path.join(app.getPath('userData'), '.env')]
    : [path.join(ROOT, '.env')]

  const env = {}
  const seen = []
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue
    seen.push(envPath)
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim())
      if (!match) continue
      env[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  }
  if (seen.length > 0) log('已读取配置：', seen.join(' → '))
  else log('未找到 .env，查找过：', candidates.join(' | '))
  return env
}

/**
 * 业务代码的位置。
 * 打包后放在 resources/app-build/（与 Electron 自己的 resources/app 分开，
 * 避免把 main.cjs 和几万个业务文件混在同一目录里）。
 */
function resourcePath(...segments) {
  return IS_PACKAGED
    ? path.join(process.resourcesPath, 'app-build', ...segments)
    : path.join(ROOT, ...segments)
}

/** 构建产物相对于 app-build 的位置（打包与开发共用同一套相对路径） */
const API_ENTRY = ['apps', 'api', 'dist', 'apps', 'api', 'src', 'server.js']
const WEB_ENTRY = ['apps', 'web', '.next', 'standalone', 'apps', 'web', 'server.js']

function spawnChild(name, entry, args, options) {
  // ELECTRON_RUN_AS_NODE：用 Electron 自带的 Node 跑服务端脚本，
  // 这样打包后不依赖用户机器上装没装 Node。
  const child = spawn(process.execPath, [entry, ...args], {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...options.env },
  })
  children.push({ name, child })
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`))
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}!] ${chunk}`))
  child.on('exit', (code, signal) => log(`${name} 退出 code=${code} signal=${signal}`))
  return child
}

async function startApi(port, env) {
  const entry = resourcePath(...API_ENTRY)
  if (!fs.existsSync(entry)) {
    throw new Error(`API 编译产物不存在：${entry}\n请先在仓库根运行：node scripts/build-api.mjs`)
  }
  spawnChild('api', entry, [], {
    cwd: IS_PACKAGED ? process.resourcesPath : ROOT,
    env: {
      ...env,
      API_PORT: String(port),
      NODE_ENV: 'production',
      STUDYGRAPH_DESKTOP: '1',
    },
  })
  await waitForHttp(`http://127.0.0.1:${port}/health`, { timeoutMs: 90000 })
  log(`API 就绪 :${port}`)
}

async function startWeb(port, apiPort, env) {
  // Next standalone：server.js 在 standalone 根目录
  const entry = resourcePath(...WEB_ENTRY)
  if (!fs.existsSync(entry)) {
    throw new Error(`Web 构建产物不存在：${entry}\n请先在 apps/web 运行 next build（需 output: 'standalone'）`)
  }
  spawnChild('web', entry, [], {
    cwd: path.dirname(entry),
    env: {
      ...env,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      // 服务端渲染时请求 API 用这个地址；运行时注入，不能靠构建期 NEXT_PUBLIC_*
      STUDYGRAPH_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      NEXT_PUBLIC_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
    },
  })
  await waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 120000 })
  log(`Web 就绪 :${port}`)
}

/**
 * BYOK 主密钥（AES-256-GCM 的 32 字节）。
 *
 * 学生机器上不可能有人去配 `BYOK_ENCRYPTION_KEY` 环境变量，所以首次启动自动生成并落盘（0600）。
 * 主密钥丢了 = 已存的厂商密钥全部解不开，因此它和数据目录同生共死：
 * 卸载保留数据时它也保留，删数据时一起删。
 */
function ensureByokKey(baseDir) {
  if (!baseDir) return null
  const keyFile = path.join(baseDir, 'byok-key.json')
  try {
    const saved = JSON.parse(fs.readFileSync(keyFile, 'utf8'))
    if (typeof saved.key === 'string' && Buffer.from(saved.key, 'base64').length === 32) return saved.key
  } catch {
    // 不存在或损坏：重新生成（损坏时旧密文已无法解开，只能重新录入）
  }
  const key = crypto.randomBytes(32).toString('base64')
  fs.writeFileSync(keyFile, `${JSON.stringify({ key }, null, 2)}\n`, { mode: 0o600 })
  log('已生成 BYOK 主密钥：', keyFile)
  return key
}

async function boot() {
  splashStage('正在读取配置', 8)
  const env = readEnvFile()

  // 内置 PostgreSQL：安装目录里带一份官方 PG16 + pgvector，数据落在用户数据目录。
  // .env 里显式给了 DATABASE_URL 就用外部库（开发期连 Docker PG 时走这条）。
  splashStage('正在启动内置数据库', 22)
  database = await resolveDatabase({
    env,
    bundleDir: IS_PACKAGED ? path.join(process.resourcesPath, 'pgsql') : path.join(ROOT, 'vendor', 'pg16'),
    migrationsDir: resourcePath('packages', 'db', 'prisma', 'migrations'),
    log,
  })
  log(`数据库模式：${database.mode}`)
  splashStage('数据库就绪，正在启动服务', 55)

  const apiPort = await freePort()
  const webPort = await freePort()
  log(`启动：api=${apiPort} web=${webPort} packaged=${IS_PACKAGED}`)
  // 本机身份：内置库里的用户与 PAT 由 pg.cjs 首次启动时自建。
  // Web 端服务端渲染与客户端请求都用它，明文只走进程环境变量，不写进任何构建产物。
  const authEnv = database.localToken ? { STUDYGRAPH_DEV_PAT: database.localToken } : {}

  // 课件存放在本机（桌面版没有 S3）：<数据目录>/objects
  const storageEnv = database.baseDir ? { STUDYGRAPH_OBJECT_DIR: path.join(database.baseDir, 'objects') } : {}

  // BYOK 主密钥：没配就自动生成，否则用户在界面上录厂商密钥会被拒（那是设计如此，见 providers.ts）
  const byokKey = env.BYOK_ENCRYPTION_KEY ?? ensureByokKey(database.baseDir)
  const byokEnv = byokKey ? { BYOK_ENCRYPTION_KEY: byokKey } : {}

  // OCR 语言包（扫描件 PDF 用）：tesseract 默认从 CDN 下，没网的电脑上第一次用就失败。
  // 包里已经带了 chi_sim + eng，这里把路径指过去。
  const ocrLangDir = IS_PACKAGED ? path.join(process.resourcesPath, 'ocr') : path.join(ROOT, 'tmp', 'ocr-langs')
  // 未预期错误的落盘目录：窗口一关就看不到控制台了，日志要留在数据目录里
  const logEnv = database.baseDir ? { STUDYGRAPH_LOG_DIR: database.baseDir } : {}

  const ocrEnv = fs.existsSync(path.join(ocrLangDir, 'chi_sim.traineddata.gz'))
    ? { STUDYGRAPH_OCR_LANG_DIR: ocrLangDir }
    : {}

  await startApi(apiPort, { ...env, ...authEnv, ...storageEnv, ...byokEnv, ...ocrEnv, ...logEnv, DATABASE_URL: database.databaseUrl })
  await startWeb(webPort, apiPort, { ...env, ...authEnv })
  return `http://127.0.0.1:${webPort}/`
}

/**
 * 讲义 PDF：把渲染进程给来的 HTML 用隐藏窗口打印成 PDF，再让用户选保存位置。
 *
 * 为什么不用 pdfkit：中文字体要自己打包、CJK 断行要自己处理，
 * 而 Chromium 本来就在包里 —— printToPDF 的排版就是浏览器排版。
 * HTML 先落临时文件再 loadFile：data: URL 有长度上限，长讲义会被截断。
 */
ipcMain.handle('studygraph:save-pdf', async (_event, html, suggestedName) => {
  const source = typeof html === 'string' ? html : ''
  if (source.trim().length === 0) return { ok: false, error: '讲义内容为空' }

  const safeName = (typeof suggestedName === 'string' ? suggestedName : '').trim() || '课程讲义'
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出讲义 PDF',
    defaultPath: `${safeName.replace(/[\/:*?"<>|]/g, '-')}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (canceled || !filePath) return { ok: false, canceled: true }

  const tempFile = path.join(app.getPath('temp'), `studygraph-lecture-${Date.now()}.html`)
  const printer = new BrowserWindow({ show: false, webPreferences: { javascript: false } })
  try {
    fs.writeFileSync(tempFile, source, 'utf8')
    await printer.loadFile(tempFile)
    const pdf = await printer.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    })
    await fs.promises.writeFile(filePath, pdf)
    return { ok: true, filePath }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    printer.destroy()
    fs.promises.unlink(tempFile).catch(() => undefined)
  }
})

/**
 * 启动画面（用户 2026-11-23 要求：启动时显示加载进度）。
 *
 * 为什么必须有：内置 PostgreSQL 首次初始化要十几秒，这段时间窗口一片空白，
 * 用户会以为没启动成功而反复双击（实际会遇到"两个实例抢同一个数据目录"）。
 * 有了进度条和阶段文字，"正在初始化数据库"和"卡死了"就能区分开。
 *
 * 图片轮换：startup/slide-*.png 存在就轮播，不存在就只显示图标 ——
 * 不因为缺图而阻塞启动。
 */
let splash = null
let splashTimer = null

function splashStages() {
  const dir = IS_PACKAGED ? path.join(process.resourcesPath, 'app', 'startup') : path.join(ROOT, 'apps', 'desktop', 'startup')
  try {
    return fs.readdirSync(dir).filter((name) => /^slide-.*.(png|jpg)$/i.test(name)).sort().map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

function createSplash() {
  const icon = IS_PACKAGED ? path.join(process.resourcesPath, 'app', 'icon.ico') : path.join(ROOT, 'apps', 'desktop', 'icon.ico')
  splash = new BrowserWindow({
    // 轮播图是 900×302 的宣传页裁切：窗口按图宽留边，否则图会被缩得看不清
    width: 720,
    height: 520,
    frame: false,
    resizable: false,
    center: true,
    show: true,
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  const slides = splashStages()
  const slideTags = slides
    .map((file, index) => '<img src="' + pathToFileURL(file).href + '" data-i="' + index + '" class="slide' + (index === 0 ? ' on' : '') + '" />')
    .join('')
  const iconUrl = fs.existsSync(icon) ? pathToFileURL(icon).href : ''
  const html =
    '<html><head><meta charset="utf-8"><style>' +
    'body{margin:0;font-family:"Microsoft YaHei",sans-serif;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;color:#0f172a}' +
    '.logo{width:72px;height:72px;margin-bottom:14px;object-fit:contain}' +
    '.title{font-size:20px;font-weight:700;letter-spacing:.5px}' +
    '.sub{font-size:12px;color:#94a3b8;margin-top:4px}' +
    '.bar{width:300px;height:5px;background:#e2e8f0;border-radius:99px;margin-top:26px;overflow:hidden}' +
    '.fill{height:100%;width:4%;background:linear-gradient(90deg,#7c3aed,#3b82f6,#10b981);border-radius:99px;transition:width .4s ease}' +
    '.stage{font-size:12px;color:#64748b;margin-top:12px;min-height:16px}' +
    '.slides{position:relative;width:100%;height:232px;margin-top:18px;display:flex;align-items:center}' +
    '.slide{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:88%;max-height:226px;object-fit:contain;opacity:0;transition:opacity .8s ease;border-radius:10px}' +
    '.slide.on{opacity:1}' +
    '</style></head><body>' +
    (iconUrl ? '<img class="logo" src="' + iconUrl + '" />' : '') +
    '<div class="title">StudyGraph</div>' +
    '<div class="sub">节点式 AI 学习工作流</div>' +
    '<div class="bar"><div class="fill" id="fill"></div></div>' +
    '<div class="stage" id="stage">正在启动…</div>' +
    (slideTags ? '<div class="slides">' + slideTags + '</div>' : '') +
    '<script>' +
    'let idx=0;const imgs=document.querySelectorAll(".slide");' +
    'setInterval(()=>{if(imgs.length<2)return;imgs[idx].classList.remove("on");idx=(idx+1)%imgs.length;imgs[idx].classList.add("on")},1800);' +
    'window.setStage=(text,pct)=>{document.getElementById("stage").textContent=text;document.getElementById("fill").style.width=Math.max(4,pct)+"%"};' +
    '</script></body></html>'

  const tmp = path.join(app.getPath('temp'), 'studygraph-splash.html')
  fs.writeFileSync(tmp, html, 'utf8')
  splash.loadFile(tmp)
  splash.on('closed', () => { splash = null })
  return splash
}

/** 更新启动进度：主进程只往页面里塞一行状态，不重建窗口 */
function splashStage(text, percent) {
  if (!splash || splash.isDestroyed()) return
  splash.webContents.executeJavaScript('window.setStage(' + JSON.stringify(text) + ',' + percent + ')').catch(() => undefined)
}

/** 启动画面至少停留一会儿：一闪而过比没有更让人困惑 */
function closeSplash(minMs = 900) {
  const finish = () => {
    if (splash && !splash.isDestroyed()) splash.close()
    splash = null
  }
  if (splashTimer) clearTimeout(splashTimer)
  splashTimer = setTimeout(finish, minMs)
}

function createWindow(url) {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'StudyGraph',
    // 窗口与任务栏图标：打包后 resources/app/icon.ico，开发态 apps/desktop/icon.ico
    icon: IS_PACKAGED ? path.join(process.resourcesPath, 'app', 'icon.ico') : path.join(ROOT, 'apps', 'desktop', 'icon.ico'),
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 讲义 PDF 需要 printToPDF（只有主进程能调），桥就是这个文件
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })
  // 冒烟钩子：设置 STUDYGRAPH_SHOT=<文件路径> 时，页面加载完成后截图并退出。
  // 用途是给"桌面壳真的能渲染界面"留下可复现的证据，而不是靠人眼看窗口。
  // STUDYGRAPH_SHOT_ROUTE 可指定具体路由（如 /settings），**只导航一次**：
  // 先跳首页再跳目标页会让两个 did-finish-load 监听互相抢，截到
  // chrome-error://chromewebdata 这种半截状态（已实测）。
  const shotPath = process.env.STUDYGRAPH_SHOT
  // 路由可以写成 `settings` 或 `/settings`：Git Bash 会把以 / 开头的环境变量值
  // 当作路径转换掉（实测变成 C:/.../PortableGit/settings），所以两种写法都要认，且要归一化。
  const rawRoute = (process.env.STUDYGRAPH_SHOT_ROUTE ?? '').replace(/^.*\/PortableGit\//, '/').replace(/^\/?/, '/')
  const targetUrl = shotPath && rawRoute !== '/' ? new URL(rawRoute, url).toString() : url

  if (shotPath) {
    window.webContents.once('did-finish-load', async () => {
      // 等首屏数据（概念卡由客户端 fetch 填充）落定
      await new Promise((resolve) => setTimeout(resolve, 2500))
      try {
        const image = await window.webContents.capturePage()
        fs.writeFileSync(shotPath, image.toPNG())
        const info = await window.webContents.executeJavaScript(
          `JSON.stringify({ url: location.href, title: document.title, cards: document.querySelectorAll('[data-testid="concept-card"]').length, drawerTestable: !!document.querySelector('[data-testid="concept-panel"]') })`,
        )
        log('冒烟截图完成：', shotPath, info)
      } catch (error) {
        log('截图失败：', error instanceof Error ? error.message : String(error))
      }
      app.quit()
    })
  }

  window.loadURL(targetUrl)
  return window
}

app.on('window-all-closed', () => app.quit())

// 单实例锁：第二个实例若照常启动，会把第一个实例正在用的数据库停掉再按新端口起，
// 正在读写的那份数据就落在半截状态里。抢不到锁就把已有窗口叫到前面，自己退出。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })
}

/**
 * 任务栏图标分组标识。
 * 不设这个，Windows 会把窗口按 exe 名归到 Electron 的默认分组，
 * 右键任务栏显示的图标和分组名都不对。
 */
if (process.platform === 'win32') app.setAppUserModelId('com.studygraph.desktop')

app.whenReady().then(async () => {
  try {
    createSplash()
    const url = await boot()
    splashStage('正在打开界面', 92)
    createWindow(url)
    closeSplash(600)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('启动失败：', message)
    dialog.showErrorBox('StudyGraph 启动失败', message)
    app.quit()
  }
})

function killChildren() {
  for (const { child } of children) if (!child.killed) child.kill()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killChildren()
    if (database) database.stop().catch(() => {})
  })
}

// 退出顺序：先收 API/Web（它们还连着库），再停 postgres。
// 用 preventDefault 等停库真的完成 —— 直接 quit 会让 postgres 变孤儿进程，
// 下次启动时残留的 postmaster.pid 会把"启动失败"甩给用户。
app.on('before-quit', (event) => {
  if (shuttingDown || !database) return
  shuttingDown = true
  event.preventDefault()
  killChildren()
  Promise.resolve(database.stop())
    .catch((error) => log('停止内置库失败：', error instanceof Error ? error.message : String(error)))
    .finally(() => {
      database = null
      app.quit()
    })
})
