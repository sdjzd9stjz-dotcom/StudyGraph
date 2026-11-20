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
const { app, BrowserWindow, dialog, shell } = require('electron')
const { spawn } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '..', '..')
const IS_PACKAGED = app.isPackaged
const children = []

const log = (...args) => console.log('[studygraph-desktop]', ...args)

/** 让系统分配一个空闲端口再释放，避免"探测后被抢占"的竞态 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

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

async function boot() {
  const env = readEnvFile()
  if (!env.DATABASE_URL) {
    throw new Error('缺少 DATABASE_URL。桌面版将内置数据库，当前开发阶段请先在仓库根 .env 配置。')
  }
  const apiPort = await freePort()
  const webPort = await freePort()
  log(`启动：api=${apiPort} web=${webPort} packaged=${IS_PACKAGED}`)
  await startApi(apiPort, env)
  await startWeb(webPort, apiPort, env)
  return `http://127.0.0.1:${webPort}/`
}

function createWindow(url) {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'StudyGraph',
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })
  window.loadURL(url)

  // 冒烟钩子：设置 STUDYGRAPH_SHOT=<文件路径> 时，页面加载完成后截图并退出。
  // 用途是给"桌面壳真的能渲染界面"留下可复现的证据，而不是靠人眼看窗口。
  const shotPath = process.env.STUDYGRAPH_SHOT
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

  return window
}

app.on('window-all-closed', () => app.quit())

app.whenReady().then(async () => {
  try {
    createWindow(await boot())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('启动失败：', message)
    dialog.showErrorBox('StudyGraph 启动失败', message)
    app.quit()
  }
})

for (const signal of ['SIGINT', 'SIGTERM', 'before-quit']) {
  process.on(signal, () => {
    for (const { child } of children) if (!child.killed) child.kill()
  })
}
