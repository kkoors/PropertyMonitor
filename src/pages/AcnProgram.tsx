import { useEffect, useState } from 'react'
import { useTableSort } from '../useTableSort'

const STATUS_BG: Record<string, string> = {
  enrolled: '#dcfce7', pending_enrollment: '#fef9c3', pending_disenrollment: '#fef9c3',
  not_enrolled: '#fee2e2', na: '#f3f4f6',
}
const STATUS_TEXT: Record<string, string> = {
  enrolled: '#166534', pending_enrollment: '#854d0e', pending_disenrollment: '#854d0e',
  not_enrolled: '#991b1b', na: '#6b7280',
}
const ALL_STATUSES = [
  { value: 'not_enrolled', label: 'Not Enrolled' },
  { value: 'pending_enrollment', label: 'Pending Enrollment' },
  { value: 'enrolled', label: 'Enrolled' },
  { value: 'pending_disenrollment', label: 'Pending Disenrollment' },
  { value: 'na', label: 'N/A' },
]
const MUNI: Record<string, string> = {
  baltimore_city: 'Baltimore City', baltimore_county: 'Baltimore County', harford: 'Harford County',
}

export default function AcnProgram({ onEditProperty, onConfigure }: { onEditProperty?: (id: number) => void, onConfigure?: () => void }) {
  const [rows, setRows] = useState<any[]>([])
  const [busy, setBusy] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const { search, setSearch, Th, apply } = useTableSort('acn', 'name')

  useEffect(() => { load() }, [])

  async function load() {
    const data = await fetch('/api/acn').then(r => r.json())
    setRows(data)
  }

  // Sends the configured notice, then moves the property to the pending state.
  async function sendNotice(r: any, kind: 'enroll' | 'disenroll') {
    const verb = kind === 'enroll' ? 'enrollment' : 'disenrollment'
    if (!confirm(`Send the ACN ${verb} email for ${r.name}?`)) return
    setBusy(r.id); setError(''); setNotice('')
    try {
      const res = await fetch(`/api/acn/${r.id}/${kind}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) setError(data.error || `Could not send the ${verb} email`)
      else setNotice(`${verb[0].toUpperCase() + verb.slice(1)} email sent to ${data.sent.to} — ${r.name} is now ${data.acn.label}`)
      await load()
    } catch (e: any) { setError(e.message) } finally { setBusy(null) }
  }

  // Used to record the utility's confirmation.
  async function setStatus(r: any, status: string) {
    setBusy(r.id); setError('')
    try {
      const res = await fetch(`/api/acn/${r.id}/status`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) setError((await res.json()).error || 'Could not update status')
      await load()
    } finally { setBusy(null) }
  }

  const monitored = apply(rows, r => [r.name, r.address, MUNI[r.municipality], r.acn.label],
    new Set(), (r, col) => (col === 'acn' ? r.acn.label : r[col]))

  const counts = rows.reduce((acc: Record<string, number>, r) => {
    acc[r.acn.status] = (acc[r.acn.status] || 0) + 1
    return acc
  }, {})

  return (
    <div>
      <div className="toolbar">
        <h1>ACN Program</h1>
        <input className="filter" style={{ minWidth: 180 }} placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
        <button className="btn btn-ghost" onClick={load}>⟳ Refresh</button>
        <button className="btn btn-ghost" onClick={() => onConfigure?.()}>✉ Email Setup</button>
      </div>

      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card"><span className="stat-label">Enrolled</span><span className="stat-value" style={{ color: '#059669' }}>{counts.enrolled || 0}</span></div>
        <div className="stat-card"><span className="stat-label">Pending</span><span className="stat-value" style={{ color: '#d97706' }}>{(counts.pending_enrollment || 0) + (counts.pending_disenrollment || 0)}</span></div>
        <div className="stat-card"><span className="stat-label">Not Enrolled</span><span className="stat-value" style={{ color: '#dc2626' }}>{counts.not_enrolled || 0}</span></div>
        <div className="stat-card"><span className="stat-label">Not Monitored</span><span className="stat-value" style={{ color: '#6b7280' }}>{counts.na || 0}</span></div>
      </div>

      {notice && <div className="card" style={{ color: '#166534', fontSize: 13 }}>{notice}</div>}
      {error && <div className="card" style={{ color: '#991b1b', fontSize: 13 }}>{error}</div>}

      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 'max-content' }}>
          <thead>
            <tr>
              <Th col="name">Property</Th><th>Address</th><Th col="municipality">Municipality</Th>
              <Th col="acn">ACN Status</Th><Th col="acn_updated_at">Updated</Th>
              <th>Action</th><th>Set Status</th>
            </tr>
          </thead>
          <tbody>
            {monitored.map(r => (
              <tr key={r.id}>
                <td>
                  <button className="btn btn-ghost btn-sm" style={{ fontWeight: 700, fontSize: 14, padding: '2px 6px', textAlign: 'left' }}
                    onClick={() => onEditProperty?.(r.id)} title="Edit property">{r.name}</button>
                </td>
                <td style={{ color: '#6b7280' }}>{r.address}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{MUNI[r.municipality] || r.municipality}</td>
                <td style={{ background: STATUS_BG[r.acn.status], color: STATUS_TEXT[r.acn.status], fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap' }}>
                  {r.acn.label}
                </td>
                <td style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{r.acn_updated_at ? r.acn_updated_at.slice(0, 10) : '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {!r.acn.monitored ? <span style={{ color: '#9ca3af' }}>—</span>
                    : r.acn.status === 'enrolled'
                      ? <button className="btn btn-ghost btn-sm" disabled={busy === r.id} onClick={() => sendNotice(r, 'disenroll')}
                          title="Email the utility to remove this property">
                          {busy === r.id ? '⟳…' : '✉ Disenroll'}
                        </button>
                      : r.acn.status === 'not_enrolled'
                        ? <button className="btn btn-primary btn-sm" disabled={busy === r.id} onClick={() => sendNotice(r, 'enroll')}
                            title="Email the utility to add this property">
                            {busy === r.id ? '⟳…' : '✉ Enroll'}
                          </button>
                        : <span style={{ fontSize: 12, color: '#854d0e' }}>awaiting confirmation</span>}
                </td>
                <td>
                  <select className="filter" style={{ fontSize: 12, padding: '2px 6px' }} value={r.acn.monitored ? r.acn.status : 'na'}
                    disabled={busy === r.id || !r.acn.monitored}
                    onChange={e => setStatus(r, e.target.value)}
                    title={r.acn.monitored ? 'Record the utility’s confirmation' : 'Property is set to not monitored for ACN'}>
                    {ALL_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {monitored.length === 0 && <div className="empty">No properties.</div>}
      </div>
    </div>
  )
}
