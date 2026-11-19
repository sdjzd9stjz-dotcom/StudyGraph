// Prisma Client 单例（SG-SUP-003 §3.1：不要每个路由 new PrismaClient()）
//
// 为什么放在 packages/db：schema、迁移、手写 SQL 都在这，客户端也归它管；
// apps/api 只 import 这一处，避免多实例把连接池撑爆。
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { __studygraphPrisma?: PrismaClient }

export const prisma =
  globalForPrisma.__studygraphPrisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  })

// 开发期热重载不重复建连接
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__studygraphPrisma = prisma
}

export { PrismaClient }
