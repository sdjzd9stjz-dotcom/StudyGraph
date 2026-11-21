import assert from 'node:assert/strict'
import test from 'node:test'

import { prisma } from '../../../../packages/db/src/index.ts'
import { buildApp } from '../../src/app.ts'
import { loadEnv } from '../../src/env.ts'

/**
 * CORS 预检必须放行 Web 端真正用到的每一个方法。
 *
 * 真实的坏法（遇到过两次）：
 *   · 上传课件带 `x-filename`，而 allow-headers 写死 → 浏览器拦掉请求，
 *     前端只看到 `Failed to fetch`，服务端日志里一行都没有
 *   · 保存"各任务用哪个模型"用 `PUT`，而 allow-methods 漏了 PUT →
 *     预检过了、真正请求被拦，表现是"选完又变回默认路由"
 *
 * 两次的共同点：**curl 测不出来**，因为 curl 不做预检。
 * 所以这条测试只能查响应头，不能查业务行为。
 */

const env = loadEnv({ ...process.env, NODE_ENV: 'test' })

test('预检响应允许 Web 端用到的全部方法与自定义头', async () => {
  const app = await buildApp({ env, prisma })
  try {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/preferences/extract',
      headers: {
        origin: 'http://127.0.0.1:3000',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization,content-type,x-filename',
      },
    })

    assert.equal(response.statusCode, 204)
    const allowedMethods = String(response.headers['access-control-allow-methods'] ?? '')
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.ok(
        allowedMethods.split(',').map((item) => item.trim()).includes(method),
        `allow-methods 缺 ${method}，浏览器会拦掉对应的请求：${allowedMethods}`,
      )
    }

    // 回显浏览器请求的头：上传需要的 x-filename 只可能从请求里来
    const allowedHeaders = String(response.headers['access-control-allow-headers'] ?? '')
    assert.ok(allowedHeaders.includes('x-filename'), `allow-headers 没有回显自定义头：${allowedHeaders}`)
  } finally {
    await app.close()
  }
})
