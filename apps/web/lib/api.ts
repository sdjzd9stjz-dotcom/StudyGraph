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

export interface CanvasNode {
  id: string
  type: string
  title: string | null
  status: string
  posX: number
  posY: number
  staleReason?: string | null
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
  if (!response.ok) return null
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
  if (!response.ok) return []
  const payload = (await response.json()) as { concepts: CanvasConcept[] }
  return payload.concepts
}

export async function fetchCanvasList(): Promise<Array<{ id: string; title: string; createdAt: string }>> {
  const response = await fetch(`${API_BASE_URL}/v1/canvases`, {
    headers: { authorization: `Bearer ${serverToken()}` },
    cache: 'no-store',
  })
  if (!response.ok) return []
  const payload = (await response.json()) as { canvases: Array<{ id: string; title: string; createdAt: string }> }
  return payload.canvases
}
