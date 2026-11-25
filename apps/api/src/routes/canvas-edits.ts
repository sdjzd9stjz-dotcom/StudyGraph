import { Prisma } from '@prisma/client'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { EdgeRouteDeps } from './edges.ts'
import { getAuth } from '../plugins/auth.ts'
import { requireCanvasWrite } from '../lib/access.ts'
import { AppError } from '../lib/errors.ts'
import { parse } from '../lib/validate.ts'

const ids = z.array(z.string().min(1)).max(2000).default([])
const targets = z.object({ nodes: ids, groups: ids, edges: ids, links: z.array(z.object({ groupId: z.string(), nodeId: z.string() })).max(2000).default([]) })
type Targets = z.infer<typeof targets>
type Tx = Prisma.TransactionClient
const sql = Prisma.sql
const problem = (text: string) => new AppError(409, 'CONFLICT', text)

// 顺序也是恢复顺序：先恢复端点，再恢复引用。表名来自程序常量，所有客户端值都用绑定参数。
function plan(canvas: string, t: Targets) {
  const list = (values: string[]) => sql`SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb)`
  const n = sql`SELECT id FROM "Node" WHERE "canvasId"=${canvas} AND id IN (${list(t.nodes)})`
  const g = sql`SELECT id FROM "NodeGroup" WHERE "canvasId"=${canvas} AND id IN (${list(t.groups)})`
  const own = sql`"nodeId" IN (${n})`
  const members = sql`${own} OR "groupId" IN (${g})`
  const links = sql`("groupId", "nodeId") IN (SELECT l."groupId", l."nodeId" FROM jsonb_to_recordset(${JSON.stringify(t.links)}::jsonb) AS l("groupId" text, "nodeId" text) JOIN "NodeGroup" ng ON ng.id=l."groupId" AND ng."canvasId"=${canvas})`
  return {
    Node: sql`id IN (${n})`, NodeGroup: sql`id IN (${g})`, Run: own, Artifact: own, Source: own,
    Span: sql`"sourceId" IN (SELECT id FROM "Source" WHERE ${own})`, NodeMessage: own, NodeSkill: own,
    Edge: sql`"canvasId"=${canvas} AND (id IN (${list(t.edges)}) OR "fromNodeId" IN (${n}) OR "toNodeId" IN (${n}))`,
    NodeGroupMember: members, NodeGroupLink: sql`${members} OR ${links}`,
  }
}
type Plan = ReturnType<typeof plan>
const tables = (p: Plan) => Object.keys(p) as (keyof Plan)[]
const table = (k: keyof Plan) => Prisma.raw('"' + k + '"')
function snapshot(p: Plan) {
  return sql`jsonb_build_object(${Prisma.join(tables(p).map(k => sql`${k}::text, (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)), '[]'::jsonb) FROM ${table(k)} r WHERE ${p[k]})`))})`
}
async function remove(tx: Tx, p: Plan) {
  const [risk] = await tx.$queryRaw<{ blocked: boolean }[]>`SELECT (
    EXISTS(SELECT 1 FROM "Run" WHERE (${p.Run}) AND status IN ('RUNNING','QUEUED','AWAITING_APPROVAL')) OR
    EXISTS(SELECT 1 FROM "Node" WHERE (${p.Node}) AND status='RUNNING') OR
    EXISTS(SELECT 1 FROM "ConceptEdge" WHERE "evidenceSourceId" IN (SELECT id FROM "Source" WHERE ${p.Source}) OR "evidenceSpanId" IN (SELECT id FROM "Span" WHERE ${p.Span})) OR
    EXISTS(SELECT 1 FROM "Artifact" WHERE NOT (${p.Artifact}) AND "runId" IN (SELECT id FROM "Run" WHERE ${p.Run}))
  ) AS blocked`
  if (risk?.blocked) throw problem('节点正在执行，或仍被其他记录作为证据引用，未删除任何内容')
  // 外键负责级联删除；对被引用的 Span 保留数据库的 RESTRICT 保护。
  for (const k of ['Edge','NodeGroupLink','NodeGroup','Node'] as const) await tx.$executeRaw(sql`DELETE FROM ${table(k)} WHERE ${p[k]}`)
}

export function registerCanvasEdits(app: FastifyInstance, { prisma, guard }: EdgeRouteDeps) {
  const history = async (tx: Tx, scope: Prisma.Sql) => (await tx.$queryRaw<{undo:string|null;redo:string|null}[]>`SELECT
    (SELECT label FROM "CanvasEdit" WHERE ${scope} AND NOT undone ORDER BY seq DESC LIMIT 1) AS undo,
    (SELECT label FROM "CanvasEdit" WHERE ${scope} AND undone ORDER BY seq LIMIT 1) AS redo`)[0]
  app.get('/v1/canvases/:canvasId/edits', { preHandler: guard('CANVAS_WRITE') }, async request => {
    const { canvasId } = request.params as { canvasId: string }
    const user = getAuth(request).user.id
    await requireCanvasWrite(prisma, canvasId, user)
    return history(prisma, sql`"canvasId"=${canvasId} AND "userId"=${user}`)
  })
  app.post('/v1/canvases/:canvasId/edits/:mode', { preHandler: guard('CANVAS_WRITE') }, async request => {
    const { canvasId, mode } = request.params as { canvasId: string; mode: string }
    const user = getAuth(request).user.id
    await requireCanvasWrite(prisma, canvasId, user)
    if (!['delete','undo','redo'].includes(mode)) throw new AppError(400,'VALIDATION_FAILED','未知编辑操作')
    const scope = sql`"canvasId"=${canvasId} AND "userId"=${user}`
    const selection = mode === 'delete' ? parse(targets, request.body) : null
    try {
      return await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${canvasId}, 0))`
        if (selection) {
          const p = plan(canvasId, selection)
          const count = selection.nodes.length + selection.groups.length + selection.edges.length + selection.links.length
          if (!count) throw problem('没有选中可删除的内容')
          const [actual] = await tx.$queryRaw<{ n: number }[]>`SELECT (
            (SELECT count(*) FROM "Node" WHERE ${p.Node}) + (SELECT count(*) FROM "NodeGroup" WHERE ${p.NodeGroup}) +
            (SELECT count(*) FROM "Edge" WHERE "canvasId"=${canvasId} AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(selection.edges)}::jsonb))) +
            (SELECT count(*) FROM "NodeGroupLink" l JOIN "NodeGroup" g ON g.id=l."groupId" WHERE g."canvasId"=${canvasId} AND (l."groupId",l."nodeId") IN (SELECT x."groupId",x."nodeId" FROM jsonb_to_recordset(${JSON.stringify(selection.links)}::jsonb) AS x("groupId" text,"nodeId" text)))
          )::int AS n`
          if (actual?.n !== count) throw problem('选中内容已改变，请刷新后再试')
          const group = selection.groups.length === 1 ? await tx.nodeGroup.findUnique({where:{id:selection.groups[0]!}, select:{title:true}}) : null
          const label = selection.groups.length ? `${selection.nodes.length ? '删除整组' : '解组'}${group ? `「${group.title}」` : ''}` : selection.nodes.length ? `删除 ${selection.nodes.length} 个节点` : `删除 ${count} 条连线`
          await tx.$executeRaw`DELETE FROM "CanvasEdit" WHERE ${scope} AND undone`
          await tx.$executeRaw`INSERT INTO "CanvasEdit" ("canvasId","userId",label,targets,snapshot) VALUES (${canvasId},${user},${label},${JSON.stringify(selection)}::jsonb,${snapshot(p)})`
          await remove(tx,p)
          await tx.$executeRaw`DELETE FROM "CanvasEdit" WHERE seq IN (SELECT seq FROM "CanvasEdit" WHERE ${scope} ORDER BY seq DESC OFFSET 50)`
          return { message: `已${label}（可撤销）`, history: await history(tx, scope) }
        }
        const undo = mode === 'undo'
        const [entry] = await tx.$queryRaw<{ seq: bigint; label: string; targets: Targets }[]>(sql`SELECT seq,label,targets FROM "CanvasEdit" WHERE ${scope} AND undone=${!undo} ORDER BY seq ${Prisma.raw(undo ? 'DESC' : 'ASC')} LIMIT 1 FOR UPDATE`)
        if (!entry) return { message: undo ? '没有可撤销的删除或解组操作' : '没有可重做的操作', unchanged: true, history: await history(tx, scope) }
        const p = plan(canvasId, entry.targets)
        if (undo) {
          for (const k of tables(p)) await tx.$executeRaw(sql`INSERT INTO ${table(k)} SELECT r.* FROM "CanvasEdit" h CROSS JOIN LATERAL jsonb_populate_recordset(NULL::${table(k)}, h.snapshot->${k}::text) r WHERE h.seq=${entry.seq}`)
        } else {
          const [same] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT snapshot=${snapshot(p)} AS ok FROM "CanvasEdit" WHERE seq=${entry.seq}`
          if (!same?.ok) throw problem('恢复的内容后来被修改了，不会用重做覆盖它')
          await remove(tx,p)
        }
        await tx.$executeRaw`UPDATE "CanvasEdit" SET undone=${undo} WHERE seq=${entry.seq}`
        return { message: `已${undo ? '撤销' : '重做'}：${entry.label}`, history: await history(tx, scope) }
      }, { isolationLevel: 'Serializable', timeout: 30000 })
    } catch (error) {
      if (error instanceof AppError) throw error
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || ['23503','23505','40001'].includes(String(error.meta?.code)))) throw problem('相关记录已改变或仍被引用，操作已回滚')
      throw error
    }
  })
}
