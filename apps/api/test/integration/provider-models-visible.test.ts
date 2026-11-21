import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { prisma } from '../../../../packages/db/src/index.ts'
import { buildApp } from '../../src/app.ts'
import { loadEnv } from '../../src/env.ts'
import { issueToken } from '../../src/lib/pat.ts'

/**
 * 停用的模型必须**看得见**。
 *
 * 用户实际遇到的问题：点了两下模型名（旧版本把它做成了启用/停用开关），
 * 两个模型都被停用；而 `GET /v1/providers` 当时只返回 `enabled: true` 的模型，
 * 于是模型从界面上彻底消失 —— 看得到"拉到 2 个模型"的提示，却一个都选不了，
 * 任务下拉也跟着空了，用户不可能猜到原因是"它们只是被停用了"。
 *
 * 这条测试守的是：停用的模型仍然出现在返回里，并且带着 enabled=false。
 * 删掉它 → 又会退回"看不见就等于删掉"，而且下一次没人能查出来。
 */

const env = loadEnv({ ...process.env, NODE_ENV: 'test' })

test('GET /v1/providers 返回停用的模型，并标出 enabled=false', async () => {
  const app = await buildApp({ env, prisma })
  try {
    const user = await prisma.user.create({
      data: { email: `${randomUUID()}@visible.invalid`, displayName: 'visible-tester' },
      select: { id: true },
    })

    const provider = await prisma.provider.create({
      data: {
        slug: `visible-${randomUUID().slice(0, 8)}`,
        name: '可见性测试',
        protocol: 'OPENAI',
        baseUrl: 'https://example.invalid/v1',
        isCustom: true,
        ownerId: user.id,
      },
      select: { id: true, slug: true },
    })

    await prisma.providerModel.createMany({
      data: [
        { providerId: provider.id, modelId: 'deepseek-chat', displayName: 'deepseek-chat', enabled: true },
        { providerId: provider.id, modelId: 'deepseek-reasoner', displayName: 'deepseek-reasoner', enabled: false },
      ],
    })

    const { token, tokenPrefix, tokenHash } = issueToken()
    await prisma.personalAccessToken.create({
      data: { userId: user.id, tokenPrefix, tokenHash, name: 'test', scopes: ['RUN_EXECUTE', 'CANVAS_READ'] },
    })

    const response = await app.inject({
      method: 'GET',
      url: '/v1/providers',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(response.statusCode, 200)

    const body = response.json() as {
      providers: Array<{ id: string; models: Array<{ modelId: string; enabled?: boolean }> }>
    }
    const found = body.providers.find((entry) => entry.id === provider.id)
    assert.ok(found, '自定义供应商必须出现在返回里')

    const byId = new Map(found.models.map((model) => [model.modelId, model]))
    assert.ok(byId.has('deepseek-chat'), '启用的模型要在')
    assert.ok(
      byId.has('deepseek-reasoner'),
      '停用的模型也必须在返回里 —— 否则界面上看不见、也启用不回来',
    )
    assert.equal(byId.get('deepseek-reasoner')?.enabled, false, '必须如实标出 enabled=false，界面靠它显示成灰色')
  } finally {
    await app.close()
  }
})
