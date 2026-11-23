import { BackLink } from '../../components/BackLink'
import { ReviewSession } from '../../components/ReviewSession'
import { API_BASE_URL, fetchDue, serverToken } from '../../lib/api'

export const dynamic = 'force-dynamic'

export default async function ReviewPage() {
  const due = await fetchDue(30)

  return (
    <main style={{ padding: 32, maxWidth: 760, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <BackLink label="复习" />
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>今日到期</h1>
        <span style={{ fontSize: 13, color: '#9ca3af' }}>{due.count} 张</span>
      </div>

      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
        按你的记忆强度排的：越难记的越早出现。答完之后系统会重新估下次什么时候再问。
      </p>

      <ReviewSession items={due.items} apiBaseUrl={API_BASE_URL} token={serverToken()} />
    </main>
  )
}
