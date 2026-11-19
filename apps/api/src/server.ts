import './load-env.ts' // 必须第一个执行

import { prisma } from '../../../packages/db/src/index.ts'
import { buildApp } from './app.ts'
import { loadEnv } from './env.ts'

const env = loadEnv()
const app = await buildApp({ env, prisma })

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, '收到退出信号，正在关闭')
  await app.close()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await app.listen({ port: env.API_PORT, host: '127.0.0.1' })
app.log.info({ port: env.API_PORT }, 'StudyGraph API 已启动')
