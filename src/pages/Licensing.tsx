import { useEffect, useState } from 'react'
import { useTableSort } from '../useTableSort'

const STATUS_BG: Record<string, string> = {
  active: '#dcfce7', expired: '#fee2e2', pending: '#fef9c3', cancelled: '#fee2e2', not_found: '#fee2e2', unknown: '#f3f4f6',
}
const STATUS_TEXT: Record<string, string> = {
  active: '#166534', expired: '#991b1b', pending: '#854d0e', cancelled: '#991b1b', not_found: '#991b1b', unknown: '#6b7280',
}

export default function Licensing({ onEditProperty }: { onEditProperty?: (id: number) => void }) {
  const [rows, setRows] = useState<any[]>([])
  const [checking, setChecking] = useState<number | null>(null)
  const [checkingAll, setCheckingAll] = useState(false)
  const [error, setError] = useState('')
  const { search, setSearch, Th, apply } = useTableSort('licensing', 'name')

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

  const monitored = apply(
    rows.filter(r => !r.commercial && !r.license_not_monitored && (r.municipality === 'baltimore_city' || r.municipality === 'baltimore_county')),
    r => [r.name, r.address, r.municipality, r.license_number, r.status],
  )

  return (
    <div>
      <div className="toolbar">
        <h1>Rental Licensing</h1>
        <input className="filter" style={{ minWidth: 180 }} placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
        <button className="btn btn-primary" onClick={checkAll} disabled={checkingAll}>
          {checkingAll ? 'Checking…' : '⟳ Check All'}
        </button>
      </div>
      {error && <div className="card" style={{ color: '#991b1b', fontSize: 13 }}>{error}</div>}
      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%' }}>
          <thead>
            <tr>
              <Th col="name">Property</Th><th>Address</th><Th col="municipality">Municipality</Th>
              <Th col="license_number">License #</Th><Th col="status">License</Th><Th col="issue_date">Issued</Th><Th col="exp_date">Expires</Th>
              <Th col="reg_status">Registration</Th><Th col="reg_exp_date">Reg Expires</Th>
              <th>Letter</th><Th col="scraped_at">Last Checked</Th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {monitored.map(r => (
              <tr key={r.id}>
                <td>
                  <button className="btn btn-ghost btn-sm" style={{ fontWeight: 700, fontSize: 14, padding: '2px 6px', textAlign: 'left' }} onClick={() => onEditProperty?.(r.id)} title="Edit property">
                    {r.name}
                  </button>
                </td>
                <td style={{ color: '#6b7280', cursor: 'pointer' }} onClick={() => onEditProperty?.(r.id)} title="Edit property">{r.address}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.municipality === 'baltimore_city' ? 'Baltimore City' : 'Baltimore County'}</td>
                {r.licenses && r.licenses.length > 1 ? (
                  <td colSpan={4} style={{ fontSize: 12 }}>
                    {r.licenses.map((l: any) => (
                      <div key={l.unit || l.license_number} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '1px 0', whiteSpace: 'nowrap' }}>
                        <span style={{ fontWeight: 700, minWidth: 46 }}>Unit {l.unit || '?'}</span>
                        <span style={{ fontFamily: 'monospace' }}>{l.license_number}</span>
                        <span style={{
                          padding: '0 6px', borderRadius: 4, fontWeight: 600,
                          background: STATUS_BG[l.status] || '#f3f4f6', color: STATUS_TEXT[l.status] || '#6b7280',
                        }}>{l.status}</span>
                        <span style={{ color: '#6b7280' }}>exp {l.exp_date || '—'}</span>
                      </div>
                    ))}
                  </td>
                ) : (<>
                <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{r.license_number || <span style={{color:'#9ca3af'}}>—</span>}</td>
                <td style={{ background: STATUS_BG[r.status] || '#f3f4f6', color: STATUS_TEXT[r.status] || '#6b7280', fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap' }}>
                  {r.status ? r.status.replace('_', ' ') : 'never checked'}
                </td>
                <td>{r.issue_date || <span style={{color:'#9ca3af'}}>—</span>}</td>
                <td>{r.exp_date || <span style={{color:'#9ca3af'}}>—</span>}</td>
                </>)}
                <td style={{
                  background: r.municipality === 'baltimore_city' ? (STATUS_BG[r.reg_status] || '#f3f4f6') : undefined,
                  color: r.municipality === 'baltimore_city' ? (STATUS_TEXT[r.reg_status] || '#6b7280') : '#9ca3af',
                  fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap',
                }}>
                  {r.municipality === 'baltimore_city' ? (r.reg_status ? r.reg_status.replace('_', ' ') : 'never checked') : 'n/a'}
                </td>
                <td>{r.municipality === 'baltimore_city' ? (r.reg_exp_date || <span style={{color:'#9ca3af'}}>—</span>) : <span style={{color:'#9ca3af'}}>—</span>}</td>
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
