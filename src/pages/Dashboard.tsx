import { useEffect, useState } from 'react'

type Page = 'dashboard' | 'properties' | 'bills' | 'scrapes'

interface Props { onNavigate: (p: Page) => void }

export default function Dashboard({ onNavigate }: Props) {
  const [stats, setStats] = useState({ properties: 0, newBills: 0, totalOwed: 0, lastRun: '' })
  const [recentBills, setRecentBills] = useState<any[]>([])
  const [scraping, setScraping] = useState(false)
  const [scrapeMsg, setScrapeMsg] = useState('')

  useEffect(() => { loadData() }, [])

  async function loadData() {
    const [propsRes, recentRes, newBillsRes, runsRes] = await Promise.all([
      fetch('/api/properties').then(r => r.json()),
      fetch('/api/bills?limit=10').then(r => r.json()),
      fetch('/api/bills?status=new&limit=500').then(r => r.json()),
      fetch('/api/scrapes').then(r => r.json()),
    ])
    const totalOwed = newBillsRes.reduce((s: number, b: any) => s + (b.amount_due || 0), 0)
    setStats({
      properties: propsRes.filter((p: any) => !p.private_ws).length,
      newBills: newBillsRes.length,
      totalOwed,
      lastRun: runsRes[0]?.finished_at || 'Never'
    })
    setRecentBills(recentRes)
  }

  async function triggerScrape() {
    setScraping(true)
    setScrapeMsg('Scrape started — this runs in the background. Refresh in a minute.')
    await fetch('/api/scrapes/run', { method: 'POST' })
    setScraping(false)
  }

  return (
    <div>
      <div className="toolbar">
        <h1>Dashboard</h1>
        <button className="btn btn-primary" onClick={triggerScrape} disabled={scraping}>
          {scraping ? 'Running…' : '⟳ Run Scrape Now'}
        </button>
      </div>
      {scrapeMsg && <div className="card" style={{ color: '#1d4ed8', marginBottom: 16 }}>{scrapeMsg}</div>}

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">Properties Monitored</span>
          <span className="stat-value blue">{stats.properties}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">New Bills</span>
          <span className="stat-value yellow">{stats.newBills}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Total Owed (New)</span>
          <span className="stat-value green">${stats.totalOwed.toFixed(2)}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Last Scrape</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#4b5563', marginTop: 4 }}>
            {stats.lastRun === 'Never' ? 'Never' : new Date(stats.lastRun).toLocaleString()}
          </span>
        </div>
      </div>

      <div className="card">
        <h2>Recent Bills</h2>
        {recentBills.length === 0 ? (
          <div className="empty">No bills yet — add properties and run a scrape.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Property</th><th>Municipality</th><th>Amount Due</th><th>Due Date</th><th>Status</th></tr>
            </thead>
            <tbody>
              {recentBills.map(b => (
                <tr key={b.id}>
                  <td>{b.property_name}</td>
                  <td><MuniBadge m={b.municipality} /></td>
                  <td><strong>${b.amount_due?.toFixed(2) ?? '—'}</strong></td>
                  <td>{b.due_date || '—'}</td>
                  <td><StatusBadge s={b.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {recentBills.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => onNavigate('bills')}>View all bills →</button>
          </div>
        )}
      </div>
    </div>
  )
}

function MuniBadge({ m }: { m: string }) {
  const map: Record<string, [string, string]> = {
    baltimore_city: ['badge-city', 'Balt. City'],
    baltimore_county: ['badge-county', 'Balt. County'],
    harford: ['badge-harford', 'Harford'],
  }
  const [cls, label] = map[m] || ['badge-gray', m]
  return <span className={`badge ${cls}`}>{label}</span>
}

function StatusBadge({ s }: { s: string }) {
  return <span className={`badge badge-${s}`}>{s}</span>
}
