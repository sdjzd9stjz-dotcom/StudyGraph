import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 对象存储（M2：接真 S3，替换 M1 的空实现）。
 *
 * 约定：
 * - 未配置 `S3_ENDPOINT` / `S3_BUCKET` 时返回 `kind: 'none'`：**put/get 直接抛错**，
 *   删除时把所有 key 记为孤儿。绝不假装成功——删库成功但删桶没做，必须在日志里看得见。
 * - key 规范：`canvas/<canvasId>/source/<sourceId>/original.pdf`、`.../text.json`
 *
 * `kind: 'local'`：桌面版用。本机目录即桶，学生机器上没有 Docker，也没有对象存储服务。
 * 语义与 S3 保持一致（put 覆盖、get 不存在即报错、deleteMany 幂等）。
 */
export interface ObjectStore {
  readonly kind: 's3' | 'local' | 'none'
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>
  get(key: string): Promise<Uint8Array>
  deleteMany(keys: readonly string[]): Promise<{ deleted: number; orphanKeys: string[] }>
  /**
   * 对象在本机的绝对路径；远程存储返回 null。
   *
   * 存在的原因：source 执行器要读原始文件的字节（PPTX/PDF 解析库都吃文件路径）。
   * 桌面版是 local，能给出路径；S3 场景下没有这个能力，调用方必须自己回退到 get()。
   */
  localPathFor?(key: string): string | null
}

export interface ObjectStoreConfig {
  readonly endpoint?: string | undefined
  readonly bucket?: string | undefined
  readonly region?: string | undefined
  readonly accessKeyId?: string | undefined
  readonly secretAccessKey?: string | undefined
  readonly forcePathStyle?: boolean
  /** kind='local' 时的根目录（桌面版：用户数据目录下的 objects/） */
  readonly localRoot?: string | undefined
}

/**
 * 本地文件即桶。
 *
 * key 一律按 `/` 分段，每段只允许 [A-Za-z0-9._-] —— 不做「把非法字符替换成下划线」，
 * 那会让两个不同 key 落成同一个文件，而且是静默的。key 由服务端生成，本来就不该有别的字符。
 */
function createLocalStore(rootDir: string): ObjectStore {
  const root = path.resolve(rootDir)

  const resolveKey = (key: string): string => {
    const segments = key.split('/').filter(Boolean)
    if (segments.length === 0) throw new Error(`对象 key 为空：${JSON.stringify(key)}`)
    for (const segment of segments) {
      if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..') {
        throw new Error(`对象 key 含非法分段：${JSON.stringify(key)}`)
      }
    }
    return path.join(root, ...segments)
  }

  return {
    kind: 'local',

    localPathFor(key) {
      return resolveKey(key)
    },

    async put(key, body) {
      const file = resolveKey(key)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, body)
    },

    async get(key) {
      const file = resolveKey(key)
      try {
        return new Uint8Array(await readFile(file))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`对象不存在：${key}`)
        throw error
      }
    },

    async deleteMany(keys) {
      const orphanKeys: string[] = []
      let deleted = 0
      for (const key of keys) {
        const file = resolveKey(key)
        try {
          await rm(file, { force: true })
          deleted += 1
        } catch {
          // 真删不掉（占用、权限）才记孤儿；不存在由 force 直接放过
          orphanKeys.push(key)
        }
      }
      return { deleted, orphanKeys }
    },
  }
}

export function createObjectStore(config: ObjectStoreConfig): ObjectStore {
  // 显式配了 S3 就用 S3；否则桌面版给一个本地根目录；两者都没有才落到 none
  if ((!config.endpoint || !config.bucket) && config.localRoot) {
    return createLocalStore(config.localRoot)
  }
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
