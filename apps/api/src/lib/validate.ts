import type { z } from 'zod'

import { validationFailed } from './errors.ts'

/** zod 校验统一出口：失败 → 400 VALIDATION_FAILED，细节进 details.issues。 */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data

  throw validationFailed({
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  })
}
