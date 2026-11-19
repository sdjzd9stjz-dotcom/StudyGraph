/**
 * 画布访问控制。
 *
 * 关键取舍：**无权限的访问一律 404，不泄露画布是否存在**（SG-SUP-003 §3.2）。
 * 只有"能看见但不许改"（只读成员）才返回 403。
 */
import type { PrismaClient } from '../../../../packages/db/src/index.ts'
import { canvasNotFound, forbidden } from '../lib/errors.ts'

export interface CanvasAccess {
  readonly canvas: {
    id: string
    ownerId: string
    title: string
    visibility: string
  }
  readonly isOwner: boolean
  readonly role: 'EDITOR' | 'VIEWER' | null
}

export async function findCanvasForUser(
  prisma: PrismaClient,
  canvasId: string,
  userId: string,
): Promise<CanvasAccess> {
  const canvas = await prisma.canvas.findUnique({
    where: { id: canvasId },
    include: { members: true },
  })

  if (!canvas) throw canvasNotFound(canvasId)

  const isOwner = canvas.ownerId === userId
  const membership = canvas.members.find((member) => member.userId === userId)

  // 既非 owner 也非成员：当作不存在
  if (!isOwner && !membership) throw canvasNotFound(canvasId)

  return {
    canvas: {
      id: canvas.id,
      ownerId: canvas.ownerId,
      title: canvas.title,
      visibility: canvas.visibility,
    },
    isOwner,
    role: (membership?.role as 'EDITOR' | 'VIEWER' | undefined) ?? null,
  }
}

/** 写操作：owner 或 EDITOR 成员。 */
export async function requireCanvasWrite(
  prisma: PrismaClient,
  canvasId: string,
  userId: string,
): Promise<CanvasAccess> {
  const access = await findCanvasForUser(prisma, canvasId, userId)
  if (!access.isOwner && access.role !== 'EDITOR') {
    throw forbidden('只读成员不能修改画布', { canvasId, role: access.role })
  }
  return access
}

/** 删除画布：只有 owner。成员可见但不可删 → 403。 */
export async function requireCanvasOwner(
  prisma: PrismaClient,
  canvasId: string,
  userId: string,
): Promise<CanvasAccess> {
  const access = await findCanvasForUser(prisma, canvasId, userId)
  if (!access.isOwner) {
    throw forbidden('只有画布所有者可以删除画布', { canvasId, role: access.role })
  }
  return access
}
