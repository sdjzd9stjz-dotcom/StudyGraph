import { z } from 'zod'

/**
 * 启动即校验：缺一个变量就退出，不留"半配置运行"（SG-SUP-003 §3.1）。
 * M2 起对象存储变成真需求，但**仍然允许缺省**——缺省时 put/get 直接抛错，
 * 不会静默降级（见 storage/object-store.ts）。
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 不能为空'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  REDIS_URL: z.string().optional(),

  /** 厂商密钥：BYOK 之外的后备来源；两个都空时 Gateway 会报 LLM_CREDENTIAL_MISSING */
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** BYOK 主密钥（32 字节 base64），未配置时 ProviderCredential 解密会拒绝 */
  BYOK_ENCRYPTION_KEY: z.string().optional(),
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
