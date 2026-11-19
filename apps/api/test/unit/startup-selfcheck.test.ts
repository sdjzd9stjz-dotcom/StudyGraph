import assert from 'node:assert/strict'
import test from 'node:test'

import { buildApp } from '../../src/app.ts'
import type { Env } from '../../src/env.ts'
import { PLANNED_PLAN } from '../../src/nodes/registry.ts'

const env: Env = {
  DATABASE_URL: 'postgresql://nobody:nothing@localhost:5999/none',
  API_PORT: 3999,
  NODE_ENV: 'test',
}

// buildApp 只用 prisma 注册路由，不会真的查询，所以这个桩足够
const stubPrisma = {} as never

test('C：注册表自检不通过时，正常启动路径拒绝构建 app（不是只在测试里断言）', async () => {
  const saved = PLANNED_PLAN.EXTRACT
  try {
    delete (PLANNED_PLAN as Record<string, string>).EXTRACT
    await assert.rejects(() => buildApp({ env, prisma: stubPrisma }), /执行器注册表自检未通过/)
  } finally {
    ;(PLANNED_PLAN as Record<string, string>).EXTRACT = saved
  }
})

test('C：自检通过时 app 能正常构建并挂上 /health', async () => {
  const app = await buildApp({ env, prisma: stubPrisma })
  try {
    const response = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(response.statusCode, 200)
  } finally {
    await app.close()
  }
})
