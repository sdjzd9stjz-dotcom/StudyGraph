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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
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

// 桌面主进程
copyFileSync(path.join(root, 'apps', 'desktop', 'main.cjs'), path.join(resources, 'app', 'main.cjs'))
writeFileSync(
  path.join(resources, 'app', 'package.json'),
  `${JSON.stringify({ name: 'studygraph', version: '0.0.0', main: 'main.cjs' }, null, 2)}\n`,
)

// ── 3. API 产物 ────────────────────────────────────────────────────────────
step('复制 API 产物')
cpSync(path.join(root, 'apps', 'api', 'dist'), path.join(appBuild, 'apps', 'api', 'dist'), { recursive: true })
// prisma schema 与迁移（首次启动内置库建表时要用）
cpSync(path.join(root, 'packages', 'db', 'prisma'), path.join(appBuild, 'packages', 'db', 'prisma'), { recursive: true })

// ── 4. Web 产物 ────────────────────────────────────────────────────────────
step('复制 Web 产物')
const standalone = path.join(root, 'apps', 'web', '.next', 'standalone')
cpSync(standalone, path.join(appBuild, 'apps', 'web', '.next', 'standalone'), { recursive: true })
// standalone 不含 static 与 public，必须单独复制，否则页面无样式
cpSync(path.join(root, 'apps', 'web', '.next', 'static'), path.join(appBuild, 'apps', 'web', '.next', 'static'), {
  recursive: true,
})
const publicDir = path.join(root, 'apps', 'web', 'public')
if (existsSync(publicDir)) {
  cpSync(publicDir, path.join(appBuild, 'apps', 'web', 'public'), { recursive: true })
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
