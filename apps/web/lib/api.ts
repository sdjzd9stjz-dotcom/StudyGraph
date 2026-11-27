/**
 * API 基地址。
 *
 * 服务端：优先 `STUDYGRAPH_API_BASE_URL`（**运行时**读取）。
 *   —— 桌面客户端每次启动都自己挑端口，构建期写死的值一定不对。
 * 客户端：由服务端通过 prop 传入 `apiBaseUrl`，不要再读 `NEXT_PUBLIC_*`
 *   （那个值在构建时就被内联进 bundle，运行时改环境变量不起作用）。
 */
function resolveApiBaseUrl(): string {
  return (
    process.env.STUDYGRAPH_API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    'http://127.0.0.1:3001'
  )
}

export const API_BASE_URL = resolveApiBaseUrl()

/** 服务端渲染时用的 token（不进浏览器 bundle）。 */
export function serverToken(): string {
  return process.env.STUDYGRAPH_DEV_PAT ?? process.env.NEXT_PUBLIC_DEV_PAT ?? ''
}

/**
 * GATE 节点的放行 / 拒绝。
 *
 * 为什么走独立接口而不是 PATCH params：放行是一次有后果的决策，
 * 要留下「谁、什么时候、为什么」。拒绝必须给理由，否则上游不知道要改什么。
 */
export async function decideGate(
  nodeId: string,
  decision: { approved: boolean; note?: string },
): Promise<{ ok: true; approved: boolean } | { ok: false; message: string }> {
  const response = await fetch(`${API_BASE_URL}/v1/nodes/${nodeId}/gate-decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${serverToken()}` },
    body: JSON.stringify(decision),
  })
  const body = (await response.json().catch(() => null)) as
    | { approved?: boolean; error?: { message?: string } }
    | null
  if (!response.ok) {
    return { ok: false, message: body?.error?.message ?? `HTTP ${response.status}` }
  }
  return { ok: true, approved: body?.approved === true }
}

export interface CanvasNode {
  skillNames: string[]
  id: string
  type: string
  title: string | null
  status: string
  posX: number
  posY: number
  staleReason?: string | null
  /** GATE 节点靠 params.approved / params.note 显示闸门状态 */
  params?: Record<string, unknown> | null
  /**
   * 最近一次运行产物的可读文本（由服务端确定性生成）。
   * null = 还没跑过。
   */
  outputText?: string | null
  outputKind?: string | null
}

export interface CanvasEdge {
  id: string
  fromNodeId: string
  toNodeId: string
  kind: string
  fromPort: string
  toPort: string
}

export async function fetchCanvas(canvasId: string): Promise<{ id: string; title: string; nodes: CanvasNode[]; edges: CanvasEdge[] } | null> {
  const response = await fetch(`${API_BASE_URL}/v1/canvases/${canvasId}`, {
    headers: { authorization: `Bearer ${serverToken()}` },
    cache: 'no-store',
  })
  if (response.status === 404) return null
  if (!response.ok) throw Error('画布读取失败')
  return (await response.json()) as { id: string; title: string; nodes: CanvasNode[]; edges: CanvasEdge[] }
}

export interface CanvasCitation {
  id: string
  quote: string | null
  isPrimary: boolean
  spanId: string
  page: number
  region: string
  charStart: number
  charEnd: number
}

export interface CanvasConcept {
  id: string
  name: string
  definition: string
  status: string
  mastery: number
  reviewedBy: string | null
  citations: CanvasCitation[]
}

export async function fetchCanvasConcepts(canvasId: string): Promise<CanvasConcept[]> {
  const response = await fetch(`${API_BASE_URL}/v1/canvases/${canvasId}/concepts`, {
    headers: { authorization: `Bearer ${serverToken()}` },
    cache: 'no-store',
  })
  if (!response.ok) throw Error('概念卡读取失败')
  const payload = (await response.json()) as { concepts: CanvasConcept[] }
  return payload.concepts
}

export async function fetchCanvasList(): Promise<Array<{ id: string; title: string; createdAt: string }>> {
  const response = await fetch(`${API_BASE_URL}/v1/canvases`, {
    headers: { authorization: `Bearer ${serverToken()}` },
    cache: 'no-store',
  })
  if (!response.ok) throw Error('画布列表读取失败')
  const payload = (await response.json()) as { canvases: Array<{ id: string; title: string; createdAt: string }> }
  return payload.canvases
}

export interface ProviderModelView {
  id: string
  modelId: string
  displayName: string
  contextWindow: number
  capabilities: Record<string, unknown>
  enabled?: boolean
}

export interface ProviderCredentialView {
  id: string
  label: string
  last4: string
  status: string
  baseUrlOverride: string | null
  createdAt: string
}

export interface ProviderView {
  id: string
  slug: string
  name: string
  protocol: 'OPENAI' | 'ANTHROPIC' | 'GEMINI'
  baseUrl: string
  docsUrl: string | null
  keyRequired: boolean
  isCustom: boolean
  models: ProviderModelView[]
  credentials: ProviderCredentialView[]
}

export interface ProviderPrefView {
  taskType: string
  credentialId: string
  modelId: string
}

export interface ProvidersPayload {
  recentUsage?: Array<{ id: string; model: string; tokensIn: number; cachedTokens: number; cacheUsageComplete: boolean | null; createdAt: string }>
  encryptionReady: boolean
  providers: ProviderView[]
  preferences: ProviderPrefView[]
  requiredCapabilities: Record<string, string | null>
}

export async function fetchProviders(): Promise<ProvidersPayload> {
  const response = await fetch(`${API_BASE_URL}/v1/providers`, {
    headers: { authorization: `Bearer ${serverToken()}` },
    cache: 'no-store',
  })
  if (!response.ok) return { encryptionReady: false, providers: [], preferences: [], requiredCapabilities: {} }
  return (await response.json()) as ProvidersPayload
}

export interface DueItem {
  id: string
  name: string
  definition: string
  canvasId: string
  canvasTitle: string
  dueAt: string
  lastReviewedAt: string | null
  isNew: boolean
  reps: number
  lapses: number
  mastery: number
}

export interface DuePayload {
  now: string
  count: number
  items: DueItem[]
}

export async function fetchDue(limit = 30): Promise<DuePayload> {
  const response = await fetch(`${API_BASE_URL}/v1/reviews/due?limit=${limit}`, {
    headers: { authorization: `Bearer ${serverToken()}` },
    cache: 'no-store',
  })
  if (!response.ok) throw Error('复习队列读取失败')
  return (await response.json()) as DuePayload
}

export interface ReviewStats {
  dueCount: number
  newCount: number
  reviewedToday: number
}

export async function fetchReviewStats(): Promise<ReviewStats> {
  const response = await fetch(`${API_BASE_URL}/v1/reviews/stats`, {
    headers: { authorization: `Bearer ${serverToken()}` },
    cache: 'no-store',
  })
  if (!response.ok) throw Error('复习统计读取失败')
  return (await response.json()) as ReviewStats
}

export interface KnowledgeNode {
  id: string
  name: string
  definition: string
  status: string
  mastery: number
  dueAt: string
  lastReviewedAt: string | null
  reps: number
  lapses: number
}

export interface KnowledgeEdge {
  id: string
  fromConceptId: string
  toConceptId: string
  status: string
  rationale: string | null
}

export interface KnowledgeGraph {
  nodes: KnowledgeNode[]
  edges: KnowledgeEdge[]
  stats: {
    conceptCount: number
    edgeCount: number
    proposedEdges: number
    byMastery: { new: number; weak: number; okay: number; strong: number }
  }
}

export async function fetchKnowledgeGraph(canvasId: string): Promise<KnowledgeGraph | null> {
  const response = await fetch(`${API_BASE_URL}/v1/canvases/${canvasId}/graph?view=knowledge`, {
    headers: { authorization: `Bearer ${serverToken()}` },
    cache: 'no-store',
  })
  if (!response.ok) return null
  return (await response.json()) as KnowledgeGraph
}

export interface GroupView {
  id: string
  title: string
  posX: number
  posY: number
  color: string
  memberIds: string[]
  usedBy: string[]
  /** 收起状态存在库里：否则重进画布会全部弹开 */
  collapsed?: boolean
}

export async function fetchGroups(canvasId: string): Promise<GroupView[]> {
  const response = await fetch(`${API_BASE_URL}/v1/canvases/${canvasId}/groups`, {
    headers: { authorization: `Bearer ${serverToken()}` },
    cache: 'no-store',
  })
  if (!response.ok) throw Error('分组读取失败')
  const payload = (await response.json()) as { groups: GroupView[] }
  return payload.groups
}

export interface SkillOption {
  id: string
  slug: string
  name: string
  description: string
  version: number
}

/** 画布页要一次性拿到：全部技能 + 每个节点已绑定的技能名 */
export async function fetchCanvasSkills(): Promise<SkillOption[]> {
  const r = await fetch(`${API_BASE_URL}/v1/skills`, { headers: { authorization: `Bearer ${serverToken()}` }, cache: 'no-store' })
  if (!r.ok) throw Error('技能读取失败')
  return (await r.json()).skills
}

export interface ErrorTagStat {
  code: string
  count: number
  label: string
  category: string
}

export interface ErrorStats {
  range: string
  attempts: number
  wrongAttempts: number
  taggedAttempts: number
  untaggedWrong: number
  distribution: ErrorTagStat[]
  byCategory: Array<{ category: string; count: number }>
}

export async function fetchErrorTags(range = '30d'): Promise<ErrorStats> {
  const response = await fetch(`${API_BASE_URL}/v1/analytics/error-tags?range=${range}`, {
    headers: { authorization: `Bearer ${serverToken()}` },
    cache: 'no-store',
  })
  if (!response.ok) {
    return { range, attempts: 0, wrongAttempts: 0, taggedAttempts: 0, untaggedWrong: 0, distribution: [], byCategory: [] }
  }
  return (await response.json()) as ErrorStats
}

export interface ErrorCatalogEntry {
  code: string
  label: string
  category: string
  description: string | null
}

export async function fetchErrorCatalog(): Promise<ErrorCatalogEntry[]> {
  const response = await fetch(`${API_BASE_URL}/v1/analytics/error-tags/catalog`, {
    headers: { authorization: `Bearer ${serverToken()}` },
    cache: 'no-store',
  })
  if (!response.ok) return []
  const payload = (await response.json()) as { tags: ErrorCatalogEntry[] }
  return payload.tags
}

export interface ProblemSummary {
  id: string
  type: string
  stem: string
  options: unknown
  answer: unknown
  judgeRule: string
  difficulty: number
  bloom: string
  status: string
  rejectReason?: string | null
  checkResult: unknown
  attempts: number
  concepts: Array<{ id: string; name: string }>
}

export async function fetchProblems(canvasId: string): Promise<ProblemSummary[]> {
  const response = await fetch(`${API_BASE_URL}/v1/problems?canvasId=${canvasId}`, {
    headers: { authorization: `Bearer ${serverToken()}` },
    cache: 'no-store',
  })
  if (!response.ok) return []
  const payload = (await response.json()) as { problems: ProblemSummary[] }
  return payload.problems
}
