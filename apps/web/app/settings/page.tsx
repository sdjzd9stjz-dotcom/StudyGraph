import Link from 'next/link'

import { BackLink } from '../../components/BackLink'

import { ProviderSettings } from '../../components/ProviderSettings'
import { API_BASE_URL, fetchProviders, serverToken } from '../../lib/api'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const data = await fetchProviders()

  return (
    <main style={{ padding: 32, maxWidth: 820, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>模型供应商</h1>
        <BackLink label="模型供应商" />
      </div>

      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
        填入自己的密钥即可使用，密钥用 AES-256-GCM 加密后只存在本机，页面上只显示末四位。
        担心隐私或想省钱，也可以加一个本地 Ollama 或你学校自己的网关。
      </p>

      <ProviderSettings data={data} apiBaseUrl={API_BASE_URL} token={serverToken()} />
    </main>
  )
}
