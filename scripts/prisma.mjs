// Prisma CLI 启动器。
//
// 为什么需要它：
//  1. nodeLinker: hoisted 下 prisma CLI 在 node_modules/prisma/build/index.js；
//     若将来切回 isolated 布局，则在 node_modules/.pnpm/prisma@*/... 下，这里两种都找。
//  2. 直接 import 该 CJS bundle 时，进程会在 stdout 管道刷新前退出，输出会丢；
//     因此用子进程 + stdio: 'inherit'（本机沙箱允许继承式 stdio，不允许管道式）。
//
// 用法（仓库根目录）：node scripts/prisma.mjs validate [其它 prisma 参数...]
import { existsSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const cliRelative = path.join('build', 'index.js')

function findCli() {
  const direct = path.join(root, 'node_modules', 'prisma', cliRelative)
  if (existsSync(direct)) return direct

  const pnpmDir = path.join(root, 'node_modules', '.pnpm')
  if (!existsSync(pnpmDir)) return null

  return (
    readdirSync(pnpmDir)
      .filter((entry) => entry.startsWith('prisma@'))
      .map((entry) => path.join(pnpmDir, entry, 'node_modules', 'prisma', cliRelative))
      .filter((candidate) => existsSync(candidate))
      .sort()
      .at(-1) ?? null
  )
}

const cliPath = findCli()
if (!cliPath) {
  console.error('找不到 prisma CLI。先执行：pnpm install --ignore-scripts')
  process.exit(1)
}

const child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
