/**
 * 对象存储删除路径（SG-SUP-003 §3.2）。
 *
 * M1 的诚实做法：**没有配置 S3 时，不假装删除成功**。
 * `deleteMany` 返回的 `orphanKeys` 会被路由记进日志与 `orphanObjects` 计数，
 * 这样"删库成功、删桶没做"这件事在日志里是可见的，不会静默。
 *
 * M2 接对象存储时，把 createObjectStore 换成 @aws-sdk/client-s3 的实现即可，
 * 上层路由不需要改——它只依赖 interface。
 */
export interface ObjectStore {
  readonly kind: 's3' | 'none'
  deleteMany(keys: readonly string[]): Promise<{ deleted: number; orphanKeys: string[] }>
}

export interface ObjectStoreConfig {
  readonly endpoint?: string | undefined
  readonly bucket?: string | undefined
}

export function createObjectStore(config: ObjectStoreConfig): ObjectStore {
  if (!config.endpoint || !config.bucket) {
    return {
      kind: 'none',
      async deleteMany(keys) {
        // 未配置存储：所有 key 都是孤儿，如实上报，不返回假的 deleted 计数
        return { deleted: 0, orphanKeys: [...keys] }
      },
    }
  }

  return {
    kind: 's3',
    async deleteMany(keys) {
      // M1 只建路径；真实实现随 M2 的对象存储一起落地（需要 @aws-sdk/client-s3）
      return { deleted: 0, orphanKeys: [...keys] }
    },
  }
}
