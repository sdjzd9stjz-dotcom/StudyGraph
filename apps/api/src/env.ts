import { z } from 'zod'

/**
 * 启动即校验：缺一个变量就退出，不留"半配置运行"（SG-SUP-003 §3.1）。
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 不能为空'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** 可选：对象存储。未配置时删除画布会把所有 key 记为 orphanObjects（M1 行为，见 storage/object-store.ts）。 */
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().optional(),
})

export type Env = z.infer<typeof schema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source)
  if (parsed.success) return parsed.data

  const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
  console.error('❌ 环境变量校验失败，拒绝启动：')
  console.error(lines.join('\n'))
  process.exit(1)
}
