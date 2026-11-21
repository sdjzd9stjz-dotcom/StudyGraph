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

/**
 * buildApp 只用 prisma 注册路由，不真的查询 —— 除了 `/health`。
 *
 * `/health` 会执行 `select 1`，库不可达时必须返回 503（桌面主进程靠状态码判断
 * "数据库真的起来了"）。所以桩必须让这次查询成功，否则这条测试测的是
 * "数据库挂了返回 503"，而不是它想测的"自检通过时 app 能构建"。
 */
const stubPrisma = {
  $queryRaw: async () => [{ '?column?': 1 }],
} as never

test('C：注册表自检不通过时，正常启动路径拒绝构建 app（不是只在测试里断言）', async () => {
  // 17 个节点全部实现后，删计划项已经不会让自检失败了（计划表本来就是空的）。
  // 要触发失败得换个真实的坏法：把一个已实现类型塞进计划表 ——
  // "已实现" 与 "计划中" 同时成立是自相矛盾的，自检必须拦下。
  const saved = PLANNED_PLAN.PREREQ
  try {
    ;(PLANNED_PLAN as Record<string, string>).PREREQ = 'M3'
    await assert.rejects(() => buildApp({ env, prisma: stubPrisma }), /执行器注册表自检未通过/)
  } finally {
    if (saved === undefined) delete (PLANNED_PLAN as Record<string, string>).PREREQ
    else (PLANNED_PLAN as Record<string, string>).PREREQ = saved
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
