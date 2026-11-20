// 把 apps/api（含 packages/contracts、packages/db 的 TS 源码）编译成可运行的 JS，
// 供桌面客户端用 Electron 自带的 Node 启动。
//
// 为什么需要：
//   · apps/api 的源码用 `allowImportingTsExtensions`（import ... from './x.ts'），
//     这个选项本身禁止 emit（noEmit 必须为 true）。
//   · TypeScript 5.9 的 `rewriteRelativeImportExtensions` 允许把 .ts 导入改写成 .js 后 emit。
//   · Electron 内置 Node 20 没有 `--experimental-strip-types`，所以桌面版只能跑编译产物。
//
// 输出目录：apps/api/dist（相对 rootDir=仓库根，保留 apps/…、packages/… 结构，
// 这样跨包的相对 import 在产物里仍然成立）
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'apps', 'api', 'dist')
const tsconfigPath = path.join(root, 'apps', 'api', 'tsconfig.build.json')

const config = {
  extends: './tsconfig.json',
  compilerOptions: {
    noEmit: false,
    outDir: 'dist',
    rootDir: '../..',
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,
    declaration: false,
    sourceMap: false,
    // 产物要能被 Electron 的 Node 直接跑：不要 type-only import 残留
    verbatimModuleSyntax: false,
  },
  include: ['src/**/*.ts', '../../packages/contracts/src/**/*.ts', '../../packages/db/src/**/*.ts'],
  exclude: ['test/**/*.ts'],
}

writeFileSync(tsconfigPath, `${JSON.stringify(config, null, 2)}\n`)

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const result = spawnSync(process.execPath, [tsc, '-p', tsconfigPath], { stdio: 'inherit', cwd: root })

if (result.status !== 0) {
  console.error('\n❌ API 编译失败')
  process.exit(result.status ?? 1)
}

const entry = path.join(outDir, 'apps', 'api', 'src', 'server.js')
if (!existsSync(entry)) {
  console.error(`❌ 编译完成但找不到入口：${entry}`)
  process.exit(1)
}
console.log(`✅ API 已编译 → ${path.relative(root, entry)}`)
