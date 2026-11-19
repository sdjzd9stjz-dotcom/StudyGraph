/**
 * 签发 Personal Access Token（M1 没有签发 UI，用这个脚本）。
 *
 * 用法：
 *   node scripts/seed-pat.ts                                  # 默认 dev@studygraph.local / 全部 scope
 *   node scripts/seed-pat.ts --email=a@b.c --scopes=canvas:read
 *   node scripts/seed-pat.ts --email=a@b.c --name=readonly --scopes=canvas:read
 *   node scripts/seed-pat.ts --user-id=u_xxx --scopes=canvas:read,canvas:write
 *
 * 行为：
 *   - 用户不存在则创建（只用于开发）
 *   - 同名 token 先吊销旧的，再签新的（可重复执行）
 *   - 明文只打印一次；库里只有 sha256
 */
import { existsSync } from 'node:fs'

import { prisma } from '../packages/db/src/index.ts'
import { issueToken, SCOPE_LABELS } from '../apps/api/src/lib/pat.ts'
import type { ScopeName } from '../apps/api/src/lib/pat.ts'

for (const candidate of ['.env', '../.env']) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate)
    break
  }
}

const SCOPE_BY_LABEL = new Map<string, ScopeName>(
  Object.entries(SCOPE_LABELS).map(([name, label]) => [label, name as ScopeName]),
)

function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq === -1) out[body] = 'true'
    else out[body.slice(0, eq)] = body.slice(eq + 1)
  }
  return out
}

function resolveScopes(raw: string | undefined): ScopeName[] {
  if (!raw) return ['CANVAS_READ', 'CANVAS_WRITE', 'RUN_EXECUTE', 'PROBLEM_READ']

  const scopes: ScopeName[] = []
  for (const part of raw.split(',').map((value) => value.trim()).filter(Boolean)) {
    const byLabel = SCOPE_BY_LABEL.get(part)
    const byName = (Object.keys(SCOPE_LABELS) as ScopeName[]).find((name) => name === part)
    const resolved = byLabel ?? byName
    if (!resolved) {
      console.error(`❌ 未知 scope：${part}。可用：${Object.values(SCOPE_LABELS).join(', ')}`)
      process.exit(1)
    }
    scopes.push(resolved)
  }
  return scopes
}

const args = parseArgs(process.argv.slice(2))
const email = args.email ?? 'dev@studygraph.local'
const tokenName = args.name ?? 'dev'
const scopes = resolveScopes(args.scopes)

const user = args['user-id']
  ? await prisma.user.findUnique({ where: { id: args['user-id'] } })
  : await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, displayName: email.split('@')[0] ?? 'dev' },
    })

if (!user) {
  console.error(`❌ 找不到用户：${args['user-id']}`)
  process.exit(1)
}

// 同名 token 幂等：先吊销，再签新的
const revoked = await prisma.personalAccessToken.updateMany({
  where: { userId: user.id, name: tokenName, revokedAt: null },
  data: { revokedAt: new Date() },
})
if (revoked.count > 0) {
  console.log(`（已吊销同名旧 token ${revoked.count} 条）`)
}

const issued = issueToken()
const record = await prisma.personalAccessToken.create({
  data: {
    userId: user.id,
    name: tokenName,
    tokenPrefix: issued.tokenPrefix,
    tokenHash: issued.tokenHash,
    scopes,
  },
})

console.log('')
console.log('✅ 已签发 Personal Access Token —— 明文只显示这一次，请立即复制保存')
console.log(`   user      : ${user.email} (id=${user.id})`)
console.log(`   token 名称: ${tokenName} (id=${record.id})`)
console.log(`   scopes    : ${scopes.map((scope) => SCOPE_LABELS[scope]).join(', ')}`)
console.log(`   token     : ${issued.token}`)
console.log(`   tokenHash : ${issued.tokenHash.slice(0, 16)}…  ← 库里存的是这个 64 位十六进制`)
console.log('')
console.log('   库里只有 sha256，运维也无法还原明文；丢了就重新签一个。')
console.log('')

await prisma.$disconnect()
