import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * BYOK 密钥加密（规格：AES-256-GCM，主密钥来自环境变量，绝不落库）。
 *
 * 库里存的是 `{ v, iv, tag, ciphertext }` 的 JSON 串；主密钥只在进程内存里出现。
 * 没有主密钥时**拒绝加密**，而不是退化成明文——退化成明文是最容易被忽略的安全事故。
 */
const ALGORITHM = 'aes-256-gcm'

export interface EncryptedSecret {
  readonly v: 1
  readonly iv: string
  readonly tag: string
  readonly ciphertext: string
}

function parseMasterKey(masterKeyBase64: string): Buffer {
  if (!masterKeyBase64) throw new Error('BYOK_ENCRYPTION_KEY 未配置，拒绝处理厂商密钥')
  const key = Buffer.from(masterKeyBase64, 'base64')
  if (key.length !== 32) {
    throw new Error(`BYOK_ENCRYPTION_KEY 必须是 32 字节（当前 ${key.length} 字节）`)
  }
  return key
}

export function encryptSecret(plaintext: string, masterKeyBase64: string): string {
  const key = parseMasterKey(masterKeyBase64)
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const payload: EncryptedSecret = {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return JSON.stringify(payload)
}

export function decryptSecret(payloadJson: string, masterKeyBase64: string): string {
  const key = parseMasterKey(masterKeyBase64)
  const payload = JSON.parse(payloadJson) as EncryptedSecret
  if (payload.v !== 1) throw new Error(`不支持的密钥版本：${String(payload.v)}`)

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  // tag 不匹配时 final() 会抛 —— 这正是我们要的：篡改过的密文不会被解出垃圾
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/** 库里展示用：只存末四位。 */
export function last4(secret: string): string {
  return secret.slice(-4)
}
