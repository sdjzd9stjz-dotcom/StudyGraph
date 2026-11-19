export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001'

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

export async function fetchCanvasList(): Promise<Array<{ id: string; title: string; createdAt: string }>> {
  const response = await fetch(`${API_BASE_URL}/v1/canvases`, {
    headers: { authorization: `Bearer ${serverToken()}` },
    cache: 'no-store',
  })
  if (!response.ok) return []
  const payload = (await response.json()) as { canvases: Array<{ id: string; title: string; createdAt: string }> }
  return payload.canvases
}
