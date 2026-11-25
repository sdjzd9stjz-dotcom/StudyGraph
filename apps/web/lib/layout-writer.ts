export type LayoutRow = { id: string; posX: number; posY: number }
export type LayoutBatch = { nodes: LayoutRow[]; groups: (LayoutRow & { collapsed: boolean })[] }

/** 拖动与退出共用顺序队列。只移除已确认的版本；失败后保留最新意图。 */
export class LayoutWriter {
  private nodes = new Map<string, LayoutRow>()
  private groups = new Map<string, LayoutBatch['groups'][number]>()
  private tail: Promise<void> = Promise.resolve()
  stage(batch: LayoutBatch) {
    for (const n of batch.nodes) this.nodes.set(n.id, n)
    for (const g of batch.groups) this.groups.set(g.id, g)
  }
  pending(): LayoutBatch { return { nodes: [...this.nodes.values()], groups: [...this.groups.values()] } }
  flush(write: (batch: LayoutBatch) => Promise<void>) {
    const run = this.tail.then(async () => {
      const batch = this.pending()
      if (!batch.nodes.length && !batch.groups.length) return
      await write(batch)
      for (const n of batch.nodes) if (this.nodes.get(n.id) === n) this.nodes.delete(n.id)
      for (const g of batch.groups) if (this.groups.get(g.id) === g) this.groups.delete(g.id)
    })
    this.tail = run.catch(() => {})
    return run
  }
}
