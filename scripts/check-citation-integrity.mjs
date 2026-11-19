// 引用漂移巡检 CLI：跑一遍全库 VERIFIED 概念，引用对不上原文的降级为 UNVERIFIED。
//
// 用法：node scripts/check-citation-integrity.mjs
import { existsSync } from 'node:fs'

import { prisma } from '../packages/db/src/index.ts'
import { checkConceptCitations } from '../apps/api/src/spans/citation-integrity.ts'
import { createObjectStore } from '../apps/api/src/storage/object-store.ts'

for (const candidate of ['.env', '../.env']) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate)
    break
  }
}

const objectStore = createObjectStore({
  endpoint: process.env.S3_ENDPOINT,
  bucket: process.env.S3_BUCKET,
  region: process.env.S3_REGION,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: true,
})

const scope = process.argv.slice(2)
if (scope.length && (scope.length !== 2 || scope[0] !== '--canvas' || !scope[1].trim())) {
  throw new Error('用法：node scripts/check-citation-integrity.mjs [--canvas <id>]')
}
const report = await checkConceptCitations({ prisma, objectStore }, scope[1])

console.log(
  JSON.stringify(
    {
      checked: report.checked,
      downgraded: report.downgraded,
      failures: report.failures,
      unverifiableSources: report.unverifiableSources,
    },
    null,
    2,
  ),
)

await prisma.$disconnect()
process.exit(report.unverifiableSources.length ? 2 : report.downgraded.length ? 1 : 0)
