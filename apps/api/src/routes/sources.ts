import type { FastifyInstance } from 'fastify'

import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { requireCanvasWrite } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import type { ObjectStore } from '../storage/object-store.ts'
import { getAuth } from '../plugins/auth.ts'
import type { Guard } from '../plugins/auth.ts'

export interface SourceRouteDeps {
  readonly prisma: PrismaClient
  readonly guard: Guard
  readonly objectStore: ObjectStore
}

/** 课件上限：60 页 PPTX 通常几 MB，100MB 足够，再大多半是误传 */
const MAX_SOURCE_BYTES = 100 * 1024 * 1024
// .ppt 是 Office 97–2003 的二进制格式，走单独的解析器（storage/ppt.ts）
const ALLOWED_EXT = /\.(pptx|ppt|pdf)$/i

/**
 * `POST /v1/canvases/:canvasId/sources` —— 上传课件，落成一个 SOURCE 节点。
 *
 * 为什么是裸字节而不是 multipart：不引新依赖，前端用 File 直接 POST body，
 * 文件名走 `x-filename` 头（URI 编码，避免中文文件名在头部被按 latin1 截断）。
 *
 * 落库顺序：先写对象存储，成功后再建节点。反过来的话，节点会指向一个不存在的文件，
 * 执行时才炸，而且看不出是哪一步坏的。
 */
export function registerSourceRoutes(app: FastifyInstance, deps: SourceRouteDeps): void {
  const { prisma, guard, objectStore } = deps

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_SOURCE_BYTES },
    (_request, body, done) => done(null, body),
  )

  app.post(
    '/v1/canvases/:canvasId/sources',
    { preHandler: guard('CANVAS_WRITE'), bodyLimit: MAX_SOURCE_BYTES },
    async (request, reply) => {
      const auth = getAuth(request)
      const { canvasId } = request.params as { canvasId: string }
      await requireCanvasWrite(prisma, canvasId, auth.user.id)

      const rawName = request.headers['x-filename']
      const encoded = Array.isArray(rawName) ? rawName[0] : rawName
      if (!encoded) throw new AppError(400, 'SOURCE_FILENAME_MISSING', '缺少 x-filename 头')
      let filename: string
      try {
        filename = decodeURIComponent(encoded)
      } catch {
        throw new AppError(400, 'SOURCE_FILENAME_INVALID', 'x-filename 不是合法的 URI 编码')
      }

      // 扫描件标记：只有用户在界面上勾了"这是扫描件"才为真。
      // 不猜：没勾就按原样处理，没有文字层时照常报错，绝不偷偷 OCR。
      const rawOcr = request.headers['x-ocr']
      const wantsOcr = (Array.isArray(rawOcr) ? rawOcr[0] : rawOcr) === '1'

      if (!ALLOWED_EXT.test(filename)) {
        throw new AppError(400, 'SOURCE_TYPE_UNSUPPORTED', `只接受 .pptx 与 .pdf，收到：${filename}`)
      }

      const body = request.body
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new AppError(400, 'SOURCE_EMPTY', '上传内容为空')
      }

      // 按扩展名决定落盘后缀 —— 千万别写成"不是 .pptx 就是 .pdf"：
      // 那会把 .ppt 存成 original.pdf，之后 PDF 解析器拿到二进制 PPT 文件，
      // 报出来的错和真正的原因完全无关。
      const lower = filename.toLowerCase()
      const ext = lower.endsWith('.pptx') ? '.pptx' : lower.endsWith('.ppt') ? '.ppt' : '.pdf'
      // 节点 id 先定下来，key 里才能带上它，省一次「建了节点再改 key」的写
      const nodeId = crypto.randomUUID()
      const key = `canvas/${canvasId}/source/${nodeId}/original${ext}`

      await objectStore.put(key, body)

      // 执行器要读原始字节；只有 local 实现给得出本机路径
      const localPath = objectStore.localPathFor?.(key) ?? null
      if (!localPath) {
        throw new AppError(
          501,
          'SOURCE_STORE_NOT_LOCAL',
          '当前对象存储不支持本机执行（M2 的 source 执行器需要本机文件路径）',
        )
      }

      const node = await prisma.node.create({
        data: {
          id: nodeId,
          canvasId,
          type: 'SOURCE',
          title: filename,
          params: { localPath, filename, ...(wantsOcr ? { ocr: true } : {}) } as object,
          status: 'DRAFT',
          posX: 0,
          posY: 0,
        },
        select: { id: true, type: true, status: true, title: true, posX: true, posY: true },
      })

      return reply.status(201).send({ node, key, bytes: body.length })
    },
  )
}
