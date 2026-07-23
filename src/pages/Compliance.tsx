import { useEffect, useState } from 'react'

type Status = 'green' | 'yellow' | 'red' | 'unknown' | 'na'

interface ComplianceItem { status: Status; label: string }
interface PropertyRow {
  id: number
  name: string
  address: string
  municipality: string
  year_built: number | null
  lead_free: number
  private_ws: number
  water: ComplianceItem
  rental_license: ComplianceItem
  lead: ComplianceItem
}

const STATUS_COLOR: Record<Status, string> = {
  green:   '#059669',
  yellow:  '#d97706',
  red:     '#dc2626',
  unknown: '#9ca3af',
  na:      '#9ca3af',
}

const STATUS_BG: Record<Status, string> = {
  green:   '#d1fae5',
  yellow:  '#fef3c7',
  red:     '#fee2e2',
  unknown: '#f3f4f6',
  na:      '#f3f4f6',
}

function StatusPill({ item }: { item: ComplianceItem }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 10px',
      borderRadius: 12,
      fontSize: 12,
      fontWeight: 600,
      background: STATUS_BG[item.status],
      color: STATUS_COLOR[item.status],
      whiteSpace: 'nowrap',
    }}>
      {item.label}
    </span>
  )
}

const MUNI_LABEL: Record<string, string> = {
  baltimore_city: 'Balt. City',
  baltimore_county: 'Balt. County',
  harford: 'Harford',
}

export default function Compliance() {
  const [rows, setRows] = useState<PropertyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState<Record<string, boolean>>({})
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [updatingAll, setUpdatingAll] = useState(false)
  const [updateMsg, setUpdateMsg] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const data = await fetch('/api/compliance').then(r => r.json())
    setRows(data)
    setLoading(false)
  }

  async function updateAllLicenses() {
    setUpdatingAll(true)
    setUpdateMsg('Checking all Baltimore County licenses…')
    try {
      const res = await fetch('/api/compliance/update-all-licenses', { method: 'POST' })
      const data = await res.json()
      setUpdateMsg(`Updated ${data.updated} properties`)
      await load()
    } catch {
      setUpdateMsg('Update failed')
    } finally {
      setUpdatingAll(false)
    }
  }

  async function runCheck(endpoint: string, key: string, label: string) {
    setChecking(c => ({ ...c, [key]: true }))
    setMessages(m => ({ ...m, [key]: '' }))
    try {
      const res = await fetch(endpoint, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) setMessages(m => ({ ...m, [key]: `Error: ${data.error}` }))
      else setMessages(m => ({ ...m, [key]: `${label} updated` }))
      await load()
    } catch {
      setMessages(m => ({ ...m, [key]: 'Request failed' }))
    } finally {
      setChecking(c => ({ ...c, [key]: false }))
    }
  }

  const summary = rows.reduce((acc, r) => {
    for (const field of ['water', 'rental_license', 'lead'] as const) {
      const s = r[field].status
      if (s === 'red') acc.red++
      else if (s === 'yellow') acc.yellow++
      else if (s === 'green') acc.green++
    }
    return acc
  }, { red: 0, yellow: 0, green: 0 })

  if (loading) return <div className="card"><div className="empty">Loading…</div></div>

  return (
    <div>
      <div className="toolbar">
        <h1>Compliance</h1>
        <button className="btn btn-ghost" onClick={load}>⟳ Refresh</button>
        <button className="btn btn-primary" disabled={updatingAll} onClick={updateAllLicenses}>
          {updatingAll ? '⟳ Checking…' : 'Update All Licenses'}
        </button>
        {updateMsg && <span style={{ fontSize: 13, color: '#2563eb' }}>{updateMsg}</span>}
      </div>

      <div className="stats-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <span className="stat-label">Issues</span>
          <span className="stat-value" style={{ color: '#dc2626' }}>{summary.red}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Expiring Soon</span>
          <span className="stat-value" style={{ color: '#d97706' }}>{summary.yellow}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Compliant</span>
          <span className="stat-value" style={{ color: '#059669' }}>{summary.green}</span>
        </div>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', tableLayout: 'auto' }}>
          <thead>
            <tr>
              <th>Property</th>
              <th>Municipality</th>
              <th>Year Built</th>
              <th>Water Bills</th>
              <th>Rental License</th>
              <th>Lead Compliance</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>
                  <strong>{r.name}</strong>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{r.address}</div>
                </td>
                <td>
                  <span className={`badge badge-${r.municipality.replace('baltimore_', '')}`}>
                    {MUNI_LABEL[r.municipality] || r.municipality}
                  </span>
                </td>
                <td style={{ textAlign: 'center' }}>
                  {r.year_built ?? <span style={{ color: '#9ca3af' }}>—</span>}
                </td>
                <td><StatusPill item={r.water} /></td>
                <td><StatusPill item={r.rental_license} /></td>
                <td><StatusPill item={r.lead} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {!r.year_built && (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={!!checking[`sdat-${r.id}`]}
                        onClick={() => runCheck(`/api/compliance/sdat/${r.id}`, `sdat-${r.id}`, 'SDAT')}
                      >
                        {checking[`sdat-${r.id}`] ? '⟳' : 'SDAT Lookup'}
                      </button>
                    )}
                    {r.municipality === 'baltimore_county' && (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={!!checking[`rl-${r.id}`]}
                        onClick={() => runCheck(`/api/compliance/rental-license/baltimore-county/${r.id}`, `rl-${r.id}`, 'Rental license')}
                      >
                        {checking[`rl-${r.id}`] ? '⟳' : 'Check License'}
                      </button>
                    )}
                    {r.year_built && r.year_built < 1978 && !r.lead_free && (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={!!checking[`mde-${r.id}`]}
                        onClick={() => runCheck(`/api/compliance/mde/${r.id}`, `mde-${r.id}`, 'MDE')}
                      >
                        {checking[`mde-${r.id}`] ? '⟳' : 'Check MDE'}
                      </button>
                    )}
                    {messages[`sdat-${r.id}`] && <div style={{ fontSize: 11, color: '#2563eb' }}>{messages[`sdat-${r.id}`]}</div>}
                    {messages[`rl-${r.id}`] && <div style={{ fontSize: 11, color: '#2563eb' }}>{messages[`rl-${r.id}`]}</div>}
                    {messages[`mde-${r.id}`] && <div style={{ fontSize: 11, color: '#2563eb' }}>{messages[`mde-${r.id}`]}</div>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
