// 必须在任何会读环境变量的模块之前执行，所以放在 server.ts 的第一个 import。
// 用 Node 内置的 loadEnvFile，不引入 dotenv（保持零额外依赖）。
import { existsSync } from 'node:fs'

for (const candidate of ['.env', '../../.env']) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate)
    break
  }
}
