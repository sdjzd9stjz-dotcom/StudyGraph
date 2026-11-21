import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/**
 * 把未预期的错误追加到本地日志文件。
 *
 * 为什么需要：桌面版的 API 是主进程的子进程，`request.log.error` 只出现在
 * 那个黑框里 —— 用户关了窗口就再也看不到。于是"服务器内部错误"变成一句
 * 无法追问的话：学生不知道发生了什么，我也拿不到现场。
 *
 * 日志目录由主进程通过 `STUDYGRAPH_LOG_DIR` 指定（通常是数据目录）；
 * 没指定就落在工作目录下的 logs/，开发时也能看。
 */
let cachedPath: string | null = null

function logPath(): string | null {
  if (cachedPath) return cachedPath
  const dir = process.env.STUDYGRAPH_LOG_DIR ?? path.join(process.cwd(), 'logs')
  try {
    mkdirSync(dir, { recursive: true })
    cachedPath = path.join(dir, 'api-errors.log')
    return cachedPath
  } catch {
    return null
  }
}

export interface ErrorContext {
  readonly method?: string
  readonly url?: string
  readonly code?: string
}

/** 写一行错误记录。任何异常都不向外抛：记日志失败不能连带把响应搞坏。 */
export function logServerError(error: unknown, context: ErrorContext = {}): void {
  const file = logPath()
  if (!file) return

  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? (error.stack ?? '') : ''
  const stamp = new Date().toISOString()
  const head = `${stamp} ${context.method ?? '-'} ${context.url ?? '-'} ${context.code ?? ''}`.trimEnd()

  try {
    appendFileSync(file, `${head}\n${message}\n${stack}\n\n`, 'utf8')
  } catch {
    // 磁盘满 / 无权限：忽略
  }
}
