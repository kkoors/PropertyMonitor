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

interface Props {
  onEditProperty: (id: number) => void
}

const STATUS_BG: Record<Status, string> = {
  green:   '#d1fae5',
  yellow:  '#fef3c7',
  red:     '#fee2e2',
  unknown: '#f3f4f6',
  na:      '#f9fafb',
}

const STATUS_TEXT: Record<Status, string> = {
  green:   '#065f46',
  yellow:  '#92400e',
  red:     '#991b1b',
  unknown: '#6b7280',
  na:      '#9ca3af',
}

const MUNI_LABEL: Record<string, string> = {
  baltimore_city:   'Balt. City',
  baltimore_county: 'Balt. County',
  harford:          'Harford',
}

function StatusCell({ item }: { item: ComplianceItem }) {
  return (
    <td style={{
      background: STATUS_BG[item.status],
      color: STATUS_TEXT[item.status],
      fontWeight: 600,
      fontSize: 14,
      whiteSpace: 'nowrap',
    }}>
      {item.label}
    </td>
  )
}

export default function Compliance({ onEditProperty }: Props) {
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
    setUpdateMsg('Checking all licenses…')
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
              <th style={{ whiteSpace: 'nowrap' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ fontWeight: 700, fontSize: 14, padding: '2px 6px', textAlign: 'left' }}
                    onClick={() => onEditProperty(r.id)}
                    title="Edit property"
                  >
                    {r.name}
                  </button>
                  <div style={{ fontSize: 12, color: '#9ca3af', paddingLeft: 6 }}>{r.address}</div>
                </td>
                <td>
                  <span className={`badge badge-${r.municipality.replace('baltimore_', '')}`}>
                    {MUNI_LABEL[r.municipality] || r.municipality}
                  </span>
                </td>
                <td style={{ textAlign: 'center', fontSize: 14 }}>
                  {r.year_built ?? <span style={{ color: '#9ca3af' }}>—</span>}
                </td>
                <StatusCell item={r.water} />
                <StatusCell item={r.rental_license} />
                <StatusCell item={r.lead} />
                <td style={{ whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', gap: 4, alignItems: 'center' }}>
                    {!r.year_built && (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={!!checking[`sdat-${r.id}`]}
                        onClick={() => runCheck(`/api/compliance/sdat/${r.id}`, `sdat-${r.id}`, 'SDAT')}
                      >
                        {checking[`sdat-${r.id}`] ? '⟳' : 'SDAT'}
                      </button>
                    )}
                    {(r.municipality === 'baltimore_county' || r.municipality === 'baltimore_city') && (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={!!checking[`rl-${r.id}`]}
                        onClick={() => runCheck(
                          `/api/compliance/rental-license/${r.municipality.replace('baltimore_', '')}/${r.id}`,
                          `rl-${r.id}`, 'License'
                        )}
                      >
                        {checking[`rl-${r.id}`] ? '⟳' : 'License'}
                      </button>
                    )}
                    {r.year_built && r.year_built < 1978 && !r.lead_free && (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={!!checking[`mde-${r.id}`]}
                        onClick={() => runCheck(`/api/compliance/mde/${r.id}`, `mde-${r.id}`, 'MDE')}
                      >
                        {checking[`mde-${r.id}`] ? '⟳' : 'MDE'}
                      </button>
                    )}
                    {messages[`sdat-${r.id}`] && <span style={{ fontSize: 11, color: '#2563eb' }}>{messages[`sdat-${r.id}`]}</span>}
                    {messages[`rl-${r.id}`] && <span style={{ fontSize: 11, color: '#2563eb' }}>{messages[`rl-${r.id}`]}</span>}
                    {messages[`mde-${r.id}`] && <span style={{ fontSize: 11, color: '#2563eb' }}>{messages[`mde-${r.id}`]}</span>}
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
