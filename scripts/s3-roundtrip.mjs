// S3 往返校验：put → get → sha256 比对 → delete → 确认读不回。
// 用途：证明对象存储真的可写可读（容器探针在 SeaweedFS 镜像里不可用）。
//
// 用法：node scripts/s3-roundtrip.mjs
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'

import { createObjectStore } from '../apps/api/src/storage/object-store.ts'

for (const candidate of ['.env', '../.env']) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate)
    break
  }
}

const config = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  bucket: process.env.S3_BUCKET ?? 'studygraph',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
  forcePathStyle: true,
}

const client = new S3Client({
  region: config.region,
  endpoint: config.endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
})

try {
  await client.send(new CreateBucketCommand({ Bucket: config.bucket }))
  console.log(`bucket created: ${config.bucket}`)
} catch (error) {
  const name = error?.name ?? 'Unknown'
  if (!/AlreadyOwned|AlreadyExists|BucketAlready/.test(name)) {
    console.error('❌ 建桶失败：', name, String(error?.message ?? error).slice(0, 120))
    process.exit(1)
  }
  console.log(`bucket 已存在：${config.bucket}`)
}

const store = createObjectStore(config)
const payload = randomBytes(64 * 1024)
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')
const key = `verify/roundtrip-${Date.now()}.bin`

await store.put(key, payload, 'application/octet-stream')
const roundTripped = await store.get(key)

const result = {
  storeKind: store.kind,
  key,
  putBytes: payload.length,
  gotBytes: roundTripped.length,
  sha256: sha(payload),
  shaMatch: sha(payload) === sha(roundTripped),
}

const removed = await store.deleteMany([key])

let readBackFails = false
try {
  await store.get(key)
} catch {
  readBackFails = true
}

console.log(JSON.stringify({ ...result, deleteMany: removed, readBackFails }, null, 2))

const ok = result.shaMatch && removed.deleted === 1 && removed.orphanKeys.length === 0 && readBackFails
console.log(ok ? '✅ S3 往返与删除均正确' : '❌ S3 往返校验失败')
process.exit(ok ? 0 : 1)
