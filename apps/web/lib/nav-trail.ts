/**
 * 页面访问轨迹（会话内）。
 *
 * 用来回答一个问题：**"返回"该回到哪儿？**
 *
 * 为什么不用 `router.back()`：浏览器历史里可能是外站、可能是表单提交后的中间态，
 * 也可能用户是直接打开链接进来的（back 会退出应用）。
 * 为什么不用 `document.referrer`：单页应用里客户端跳转不更新它，永远是首次加载的来源。
 *
 * 所以自己记：每次进入一个页面就往栈里压一条 {path, label}。
 * 返回链接取"上一条"，既知道路径也知道该显示什么名字 ——
 * 用户要求的就是「← 返回<上一界面名字>」，而不是笼统的「返回」。
 *
 * 只存在 sessionStorage：同一次会话里的次序有意义，重启后旧轨迹反而会误导。
 */

const KEY = 'studygraph.nav-trail'
const MAX = 30

export interface TrailEntry {
  path: string
  label: string
}

function read(): TrailEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.sessionStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is TrailEntry =>
        Boolean(item) && typeof (item as TrailEntry).path === 'string' && typeof (item as TrailEntry).label === 'string',
    )
  } catch {
    return []
  }
}

function write(entries: TrailEntry[]): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX)))
  } catch {
    // 存不进去（隐私模式/配额）就算了：返回链接退化成默认目标，不该影响其它功能
  }
}

/** 当前路径的数字/查询串之外的"页面身份"，用来判断是不是同一个页面 */
function normalize(path: string): string {
  return path.split('#')[0] ?? path
}

/**
 * 记录当前页。
 *
 * 连续重复访问同一页只留一条（刷新不算"上一个界面"）；
 * 但如果用户 A→B→A，A 会出现两次 —— 这是对的，返回确实应该回到 A。
 */
export function recordVisit(entry: TrailEntry): void {
  if (typeof window === 'undefined') return
  const entries = read()
  const last = entries[entries.length - 1]
  if (last && normalize(last.path) === normalize(entry.path)) {
    // 同一页重进（刷新/标题变了）：更新名字，不新增
    last.label = entry.label
    write(entries)
    return
  }
  // 往回退到栈里已有的页面：把中间那些"被退出去"的条目丢掉
  const existing = entries.findIndex((item) => normalize(item.path) === normalize(entry.path))
  if (existing >= 0) {
    entries.length = existing
    entries.push(entry)
    write(entries)
    return
  }
  entries.push(entry)
  write(entries)
}

/** 上一个页面（不含当前页）；没有就返回 null，由调用方决定默认目标 */
export function previousEntry(currentPath: string): TrailEntry | null {
  const entries = read()
  const index = entries.findIndex((item) => normalize(item.path) === normalize(currentPath))
  if (index > 0) return entries[index - 1] ?? null
  // 当前页没记录（比如服务端渲染首帧）时，取最后一条不是自己的
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const item = entries[i]!
    if (normalize(item.path) !== normalize(currentPath)) return item
  }
  return null
}
