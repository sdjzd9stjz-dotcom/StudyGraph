import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

process.chdir(fileURLToPath(new URL('../', import.meta.url)))
if (process.argv.slice(2).some(arg => !['--preflight','--recover-a1'].includes(arg))) {
  throw new Error('仅支持可选参数 --preflight。密钥请在隐藏提示中输入。')
}
process.loadEnvFile('.env')

if (!process.argv.includes('--preflight')) {
  if (existsSync('docs/交付/实调证据-011-DeepSeek.jsonl') && !process.argv.includes('--recover-a1')) {
    throw new Error('011 已有实调账本，请先核对上次结果。')
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('请在本机交互式终端运行，密钥输入需要隐藏。')
  }
  const muted = new Writable({ write(_chunk, _encoding, done) { done() } })
  const reader = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 })
  const cancel = new AbortController()
  reader.once('SIGINT', () => cancel.abort())
  reader.once('close', () => cancel.abort())
  process.stdout.write('请输入轮换后的 DeepSeek 密钥（输入不显示，回车开始；Ctrl+C 取消）：')
  let key
  try {
    key = (await reader.question('', { signal: cancel.signal })).trim()
  } catch (error) {
    if (!cancel.signal.aborted) throw error
  } finally {
    reader.close()
    process.stdout.write('\n')
  }
  if (!key) {
    console.log('已取消，未发起请求。')
    process.exit(0)
  }
  process.env.DEEPSEEK_API_KEY = key
}

try {
  await import('./run-011-deepseek.mjs')
} finally {
  delete process.env.DEEPSEEK_API_KEY
}
