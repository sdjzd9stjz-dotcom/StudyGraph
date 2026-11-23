import { API_BASE_URL, fetchCanvasList, fetchReviewStats, serverToken } from '../lib/api'
import { CanvasList } from '../components/CanvasList'

export const dynamic = 'force-dynamic'

/**
 * 首页：画布列表。
 *
 * 列表交互（右键重命名/删除、拖动排序、表头冻结、新建对话框）都在客户端组件里，
 * 这一层只负责取数据 —— 服务端组件不能处理事件，混在一起会让表头每次交互都整页重渲。
 */
export default async function HomePage() {
  const [canvases, stats] = await Promise.all([fetchCanvasList(), fetchReviewStats()])

  return (
    <main>
      <CanvasList
        canvases={canvases}
        apiBaseUrl={API_BASE_URL}
        token={serverToken()}
        dueTotal={stats.dueCount + stats.newCount}
      />
    </main>
  )
}
