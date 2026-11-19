import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

/**
 * 对象存储（M2：接真 S3，替换 M1 的空实现）。
 *
 * 约定：
 * - 未配置 `S3_ENDPOINT` / `S3_BUCKET` 时返回 `kind: 'none'`：**put/get 直接抛错**，
 *   删除时把所有 key 记为孤儿。绝不假装成功——删库成功但删桶没做，必须在日志里看得见。
 * - key 规范：`canvas/<canvasId>/source/<sourceId>/original.pdf`、`.../text.json`
 */
export interface ObjectStore {
  readonly kind: 's3' | 'none'
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>
  get(key: string): Promise<Uint8Array>
  deleteMany(keys: readonly string[]): Promise<{ deleted: number; orphanKeys: string[] }>
}

export interface ObjectStoreConfig {
  readonly endpoint?: string | undefined
  readonly bucket?: string | undefined
  readonly region?: string | undefined
  readonly accessKeyId?: string | undefined
  readonly secretAccessKey?: string | undefined
  readonly forcePathStyle?: boolean
}

export function createObjectStore(config: ObjectStoreConfig): ObjectStore {
  if (!config.endpoint || !config.bucket) {
    return {
      kind: 'none',
      async put() {
        throw new Error('对象存储未配置（缺 S3_ENDPOINT / S3_BUCKET）')
      },
      async get() {
        throw new Error('对象存储未配置（缺 S3_ENDPOINT / S3_BUCKET）')
      },
      async deleteMany(keys) {
        return { deleted: 0, orphanKeys: [...keys] }
      },
    }
  }

  const client = new S3Client({
    region: config.region ?? 'us-east-1',
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle ?? true,
    ...(config.accessKeyId && config.secretAccessKey
      ? { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }
      : {}),
  })

  const bucket = config.bucket

  return {
    kind: 's3',

    async put(key, body, contentType = 'application/octet-stream') {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      )
    },

    async get(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      if (!response.Body) throw new Error(`S3 对象为空：${key}`)
      return response.Body.transformToByteArray()
    },

    async deleteMany(keys) {
      if (keys.length === 0) return { deleted: 0, orphanKeys: [] }

      const orphanKeys: string[] = []
      let deleted = 0

      // DeleteObjects 一次最多 1000 个
      for (let offset = 0; offset < keys.length; offset += 1000) {
        const batch = keys.slice(offset, offset + 1000)
        const response = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: false },
          }),
        )
        deleted += response.Deleted?.length ?? 0
        for (const error of response.Errors ?? []) {
          orphanKeys.push(error.Key ?? '<unknown>')
        }
      }

      return { deleted, orphanKeys }
    },
  }
}
