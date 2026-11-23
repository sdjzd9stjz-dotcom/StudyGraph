// 把 StudyGraph 打包成可双击运行的桌面程序（Windows exe 目录形态）。
//
// 为什么不用 electron-builder 直接打：
//   · 项目是 pnpm workspace + hoisted 布局，electron-builder 对 workspace 的依赖归集
//     很容易把整个 712MB node_modules 塞进包里；
//   · 这里改成"干净目录 + 只装生产依赖"，产物体积可控、依赖清单可审计。
//
// 产物结构（<out>/StudyGraph/）：
//   StudyGraph.exe            ← Electron 主程序（换名）
//   resources/app/main.cjs    ← 桌面主进程
//   resources/app-build/
//       apps/api/dist/…       ← API 编译产物
//       apps/web/.next/standalone/… ← Next 独立产物（自带 server.js 与依赖）
//       apps/web/.next/static ← 静态资源（standalone 不带，必须单独复制）
//       apps/web/public       ← 若有
//       node_modules/         ← 只为 API 准备的运行时依赖
//
// 用法：node scripts/build-desktop.mjs
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
// 输出目录带版本时间戳：Windows 上上一次打包的 exe 常被系统/杀软短暂占用，
// 复用一个固定目录会让"删旧产物"变成打包的前置失败点。保留最近几次也便于对比。
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const outRoot = path.join(root, 'dist-desktop', stamp)
const appDir = path.join(outRoot, 'StudyGraph')
const resources = path.join(appDir, 'resources')
const appBuild = path.join(resources, 'app-build')

const step = (label) => console.log(`\n=== ${label} ===`)

// ── 0. 前置检查 ────────────────────────────────────────────────────────────
step('前置检查')
const electronDir = path.join(root, 'node_modules', 'electron', 'dist')
if (!existsSync(path.join(electronDir, 'electron.exe'))) {
  console.error('❌ 找不到 electron 二进制。请先运行 node node_modules/electron/install.js')
  process.exit(1)
}
console.log('electron:', readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8').match(/"version":\s*"([^"]+)"/)?.[1] ?? '?')

// ── 1. 编译 API 与构建 Web ─────────────────────────────────────────────────
step('编译 API')
let run = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-api.mjs')], { stdio: 'inherit', cwd: root })
if (run.status !== 0) process.exit(run.status ?? 1)

step('构建 Web（standalone）')
run = spawnSync(process.execPath, [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], {
  stdio: 'inherit',
  cwd: path.join(root, 'apps', 'web'),
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
})
if (run.status !== 0) process.exit(run.status ?? 1)

// ── 2. 准备输出目录 ────────────────────────────────────────────────────────
step('准备输出目录')
if (existsSync(outRoot)) rmSync(outRoot, { recursive: true, force: true })
mkdirSync(path.join(resources, 'app'), { recursive: true })
mkdirSync(appBuild, { recursive: true })

// Electron 主体
cpSync(electronDir, appDir, { recursive: true })
const electronExe = path.join(appDir, 'electron.exe')
const appExe = path.join(appDir, 'StudyGraph.exe')
cpSync(electronExe, appExe)
rmSync(electronExe, { force: true })
// Electron 需要 resources/default_app.asar 之外的 app 目录；改名后的 exe 仍然读取 resources/app
console.log('Electron 已复制 →', appDir)

// 桌面主进程（pg.cjs 是内置数据库的生命周期模块，必须一起带上）
copyFileSync(path.join(root, 'apps', 'desktop', 'main.cjs'), path.join(resources, 'app', 'main.cjs'))
copyFileSync(path.join(root, 'apps', 'desktop', 'pg.cjs'), path.join(resources, 'app', 'pg.cjs'))
// preload：讲义 PDF 的唯一桥，漏复制会让打印按钮静默失效
copyFileSync(path.join(root, 'apps', 'desktop', 'preload.cjs'), path.join(resources, 'app', 'preload.cjs'))
writeFileSync(
  path.join(resources, 'app', 'package.json'),
  `${JSON.stringify({ name: 'studygraph', version: '0.0.0', main: 'main.cjs' }, null, 2)}\n`,
)

// ── 2.4 使用说明书（应用内「使用教程」页读它，不复制内容以免分叉）─────────
step('复制使用说明书')
const guideDirs = [
  path.join(appBuild, 'apps', 'web', 'docs'),
  path.join(appBuild, 'docs'),
]
for (const dir of guideDirs) {
  mkdirSync(dir, { recursive: true })
  copyFileSync(path.join(root, 'docs', '使用说明书.md'), path.join(dir, '使用说明书.md'))
}
if (existsSync(path.join(root, 'docs', '使用说明书.pdf'))) {
  for (const dir of guideDirs) {
    copyFileSync(path.join(root, 'docs', '使用说明书.pdf'), path.join(dir, '使用说明书.pdf'))
  }
}
console.log('说明书已复制到', guideDirs.map((dir) => path.relative(appBuild, dir)).join(' / '))

// ── 2.5 内置 PostgreSQL 运行时 ─────────────────────────────────────────────
step('复制内置 PostgreSQL')
const pgRuntime = path.join(root, 'vendor', 'pg16')
if (!existsSync(path.join(pgRuntime, 'bin', 'pg_ctl.exe'))) {
  console.error('❌ 缺少 vendor/pg16。请先运行：node scripts/prepare-pg-runtime.mjs')
  process.exit(1)
}
// 放在 resources/pgsql：与 app-build 平级，pg.cjs 里按 process.resourcesPath/pgsql 找
cpSync(pgRuntime, path.join(resources, 'pgsql'), { recursive: true })
const pgManifest = JSON.parse(readFileSync(path.join(pgRuntime, 'PG-BUNDLE.json'), 'utf8'))
console.log(`PostgreSQL ${pgManifest.postgres} + pgvector 已打包`)

// ── 2.6 OCR 语言包 ─────────────────────────────────────────────────────────
step('复制 OCR 语言包')
/**
 * 扫描件 PDF 要靠 tesseract 识别，而它默认**从 CDN 下语言包** ——
 * 没网的电脑上第一次用就失败。所以把 chi_sim 与 eng 直接打进包里（约 31MB）。
 *
 * 放 resources/ocr：tesseract 的 langPath 只接受一个目录，两种语言必须在同一处，
 * 所以这里合并两个 npm 包里的 .gz，而不是直接搬它们的目录。
 */
const ocrTarget = path.join(resources, 'ocr')
mkdirSync(ocrTarget, { recursive: true })
const ocrLangs = [
  ['chi_sim', path.join(root, 'node_modules', '@tesseract.js-data', 'chi_sim', '4.0.0', 'chi_sim.traineddata.gz')],
  ['eng', path.join(root, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0', 'eng.traineddata.gz')],
]
let ocrBytes = 0
for (const [lang, source] of ocrLangs) {
  if (!existsSync(source)) {
    console.error(`❌ 缺少 OCR 语言包：${source}\n   请先运行：npm install @tesseract.js-data/${lang}`)
    process.exit(1)
  }
  copyFileSync(source, path.join(ocrTarget, `${lang}.traineddata.gz`))
  ocrBytes += statSync(source).size
}
console.log(`OCR 语言包 chi_sim + eng 已打包（${Math.round(ocrBytes / 1048576)}MB）`)

// ── 3. API 产物 ────────────────────────────────────────────────────────────
step('复制 API 产物')
cpSync(path.join(root, 'apps', 'api', 'dist'), path.join(appBuild, 'apps', 'api', 'dist'), { recursive: true })
// prisma schema 与迁移（首次启动内置库建表时要用）
cpSync(path.join(root, 'packages', 'db', 'prisma'), path.join(appBuild, 'packages', 'db', 'prisma'), { recursive: true })

// ── 4. Web 产物 ────────────────────────────────────────────────────────────
step('复制 Web 产物')
const standalone = path.join(root, 'apps', 'web', '.next', 'standalone')
const standaloneOut = path.join(appBuild, 'apps', 'web', '.next', 'standalone')
cpSync(standalone, standaloneOut, { recursive: true })

// standalone 不含 static 与 public，必须单独复制。
//
// 位置很关键：Next 的 standalone server.js 是**从 cwd 下的 .next/static 提供静态资源**，
// 而 main.cjs 把 cwd 设成 server.js 所在目录，即
//   app-build/apps/web/.next/standalone/apps/web
// 所以 static 必须落到 **standalone 内部** 的同级位置。
// 早先复制到 app-build/apps/web/.next/static（少了一层 standalone）的后果是：
// HTML 能出来，但所有 JS 与 CSS 都 404 —— 页面看起来"渲染了"，
// 实际客户端永不水合，按钮的点击事件根本没绑上，点「新建画布」毫无反应。
const webAppInStandalone = path.join(standaloneOut, 'apps', 'web')
cpSync(path.join(root, 'apps', 'web', '.next', 'static'), path.join(webAppInStandalone, '.next', 'static'), { recursive: true })
const publicDir = path.join(root, 'apps', 'web', 'public')
if (existsSync(publicDir)) {
  cpSync(publicDir, path.join(webAppInStandalone, 'public'), { recursive: true })
}

// ── 5. API 运行时依赖（只装生产依赖，不带 devDependencies）────────────────
step('安装 API 生产依赖')
const apiPkg = JSON.parse(readFileSync(path.join(root, 'apps', 'api', 'package.json'), 'utf8'))
const runtimePkg = {
  name: 'studygraph-runtime',
  private: true,
  type: 'module',
  dependencies: apiPkg.dependencies,
}
writeFileSync(path.join(appBuild, 'package.json'), `${JSON.stringify(runtimePkg, null, 2)}\n`)

// Windows 上 npm 是 npm.cmd，spawnSync 不走 shell 会 ENOENT —— 必须加 shell: true，
// 否则会以"打包失败"的形式暴露，而真实原因只是找不到可执行文件。
run = spawnSync(
  'npm',
  ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmmirror.com'],
  {
    cwd: appBuild,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:7897', HTTP_PROXY: 'http://127.0.0.1:7897' },
  },
)
if (run.status !== 0) {
  console.error(`❌ 安装 API 生产依赖失败（exit ${run.status}）`)
  process.exit(run.status ?? 1)
}

// Prisma 客户端引擎：npm install 时 --ignore-scripts 跳过了 generate，直接把仓库里已生成的复制过去
step('复制 Prisma 引擎')
const prismaGenerated = path.join(root, 'node_modules', '.prisma')
if (!existsSync(prismaGenerated)) {
  console.error('❌ 仓库里没有 node_modules/.prisma，请先在仓库根运行 prisma generate')
  process.exit(1)
}
cpSync(prismaGenerated, path.join(appBuild, 'node_modules', '.prisma'), { recursive: true })

// ── 6. 结果 ────────────────────────────────────────────────────────────────
step('完成')
const sizeOf = (dir) => {
  const r = spawnSync('du', ['-sh', dir], { encoding: 'utf8' })
  return (r.stdout || '').split(/\s+/)[0] || '?'
}
console.log('输出目录:', appDir)
console.log('总大小  :', sizeOf(appDir))
console.log('可执行  :', appExe)
