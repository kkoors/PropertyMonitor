import { useEffect, useState, useMemo } from 'react'

type Status = 'green' | 'yellow' | 'red' | 'unknown' | 'na'
type SortCol = 'name' | 'municipality' | 'year_built' | 'water' | 'rental_license' | 'city_registration' | 'lead'

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
  rental_license_has_letter: boolean
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

const STATUS_ORDER: Record<Status, number> = { red: 0, yellow: 1, unknown: 2, na: 3, green: 4 }

const MUNI_LABEL: Record<string, string> = {
  baltimore_city:   'Baltimore City',
  baltimore_county: 'Baltimore County',
  harford:          'Harford County',
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
  const [search, setSearch] = useState('')
  const [sortCol, setSortCol] = useState<SortCol>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

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

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const sortArrow = (col: SortCol) => sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''

  const q = search.toLowerCase()
  const displayed = useMemo(() => {
    const filtered = rows.filter(r =>
      !q ||
      r.name.toLowerCase().includes(q) ||
      r.address.toLowerCase().includes(q) ||
      (MUNI_LABEL[r.municipality] || r.municipality).toLowerCase().includes(q)
    )
    return [...filtered].sort((a, b) => {
      let cmp = 0
      if (sortCol === 'name') cmp = a.name.localeCompare(b.name)
      else if (sortCol === 'municipality') cmp = a.municipality.localeCompare(b.municipality)
      else if (sortCol === 'year_built') cmp = (a.year_built ?? 0) - (b.year_built ?? 0)
      else if (sortCol === 'water') cmp = STATUS_ORDER[a.water.status] - STATUS_ORDER[b.water.status]
      else if (sortCol === 'rental_license') cmp = STATUS_ORDER[a.rental_license.status] - STATUS_ORDER[b.rental_license.status]
      else if (sortCol === 'city_registration') cmp = STATUS_ORDER[a.city_registration.status] - STATUS_ORDER[b.city_registration.status]
      else if (sortCol === 'lead') cmp = STATUS_ORDER[a.lead.status] - STATUS_ORDER[b.lead.status]
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [rows, q, sortCol, sortDir])

  const summary = rows.reduce((acc, r) => {
    for (const field of ['water', 'rental_license', 'lead'] as const) {
      const s = r[field].status
      if (s === 'red') acc.red++
      else if (s === 'yellow') acc.yellow++
      else if (s === 'green') acc.green++
    }
    return acc
  }, { red: 0, yellow: 0, green: 0 })

  const Th = ({ col, children }: { col: SortCol; children: React.ReactNode }) => (
    <th style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} onClick={() => toggleSort(col)}>
      {children}{sortArrow(col)}
    </th>
  )

  if (loading) return <div className="card"><div className="empty">Loading…</div></div>

  return (
    <div>
      <div className="toolbar">
        <h1>Compliance</h1>
        <input
          className="filter"
          placeholder="Search properties…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ minWidth: 200 }}
        />
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
              <Th col="name">Property</Th>
              <Th col="municipality">Municipality</Th>
              <Th col="year_built">Year Built</Th>
              <Th col="water">Water Bills</Th>
              <Th col="rental_license">Rental License</Th>
              <Th col="city_registration">Registration</Th>
              <Th col="lead">Lead Compliance</Th>
              <th style={{ whiteSpace: 'nowrap' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map(r => (
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
                <td style={{ fontSize: 14 }}>{MUNI_LABEL[r.municipality] || r.municipality}</td>
                <td style={{ textAlign: 'center', fontSize: 14 }}>
                  {r.year_built ?? <span style={{ color: '#9ca3af' }}>—</span>}
                </td>
                <StatusCell item={r.water} />
                <StatusCell item={r.rental_license} />
                <StatusCell item={r.city_registration} />
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
                    {r.rental_license_has_letter && (
                      <a
                        className="btn btn-ghost btn-sm"
                        href={`/api/compliance/rental-license/letter/${r.id}/${r.municipality}`}
                        target="_blank"
                        rel="noreferrer"
                        title="Download Registration Confirmation Letter"
                      >
                        📄
                      </a>
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
        {displayed.length === 0 && <div className="empty">No properties match "{search}"</div>}
      </div>
    </div>
  )
}
