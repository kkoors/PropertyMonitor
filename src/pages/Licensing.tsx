import { useEffect, useState } from 'react'

const STATUS_BG: Record<string, string> = {
  active: '#dcfce7', expired: '#fee2e2', pending: '#fef9c3', cancelled: '#fee2e2', not_found: '#fee2e2', unknown: '#f3f4f6',
}
const STATUS_TEXT: Record<string, string> = {
  active: '#166534', expired: '#991b1b', pending: '#854d0e', cancelled: '#991b1b', not_found: '#991b1b', unknown: '#6b7280',
}

export default function Licensing() {
  const [rows, setRows] = useState<any[]>([])
  const [checking, setChecking] = useState<number | null>(null)
  const [checkingAll, setCheckingAll] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    const data = await fetch('/api/compliance/licenses').then(r => r.json())
    setRows(data)
  }

  async function check(r: any) {
    setChecking(r.id); setError('')
    try {
      const kind = r.municipality.replace('baltimore_', '')
      const res = await fetch(`/api/compliance/rental-license/${kind}/${r.id}`, { method: 'POST' })
      if (!res.ok) { const e = await res.json(); setError(`${r.name}: ${e.error}`) }
      await load()
    } finally { setChecking(null) }
  }

  async function checkAll() {
    setCheckingAll(true); setError('')
    try {
      await fetch('/api/compliance/update-all-licenses', { method: 'POST' })
      await load()
    } finally { setCheckingAll(false) }
  }

  const monitored = rows.filter(r => !r.commercial && !r.license_not_monitored && (r.municipality === 'baltimore_city' || r.municipality === 'baltimore_county'))

  return (
    <div>
      <div className="toolbar">
        <h1>Rental Licensing</h1>
        <button className="btn btn-primary" onClick={checkAll} disabled={checkingAll}>
          {checkingAll ? 'Checking…' : '⟳ Check All'}
        </button>
      </div>
      {error && <div className="card" style={{ color: '#991b1b', fontSize: 13 }}>{error}</div>}
      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Property</th><th>Address</th><th>Municipality</th>
              <th>License #</th><th>Status</th><th>Issued</th><th>Expires</th><th>Letter</th><th>Last Checked</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {monitored.map(r => (
              <tr key={r.id}>
                <td><strong>{r.name}</strong></td>
                <td style={{ color: '#6b7280' }}>{r.address}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.municipality === 'baltimore_city' ? 'Baltimore City' : 'Baltimore County'}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{r.license_number || <span style={{color:'#9ca3af'}}>—</span>}</td>
                <td style={{ background: STATUS_BG[r.status] || '#f3f4f6', color: STATUS_TEXT[r.status] || '#6b7280', fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap' }}>
                  {r.status ? r.status.replace('_', ' ') : 'never checked'}
                </td>
                <td>{r.issue_date || <span style={{color:'#9ca3af'}}>—</span>}</td>
                <td>{r.exp_date || <span style={{color:'#9ca3af'}}>—</span>}</td>
                <td>{r.has_letter ? <a href={`/api/compliance/rental-license/letter/${r.id}/${r.municipality}`} target="_blank" rel="noreferrer">📄</a> : <span style={{color:'#9ca3af'}}>—</span>}</td>
                <td style={{ fontSize: 12, color: '#6b7280' }}>{r.scraped_at ? r.scraped_at.slice(0, 10) : '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn btn-primary btn-sm" onClick={() => check(r)} disabled={checking === r.id}>
                    {checking === r.id ? '⟳…' : '⟳ Check'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {monitored.length === 0 && <div className="empty">No properties require rental licensing.</div>}
      </div>
    </div>
  )
}
