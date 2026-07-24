import { useEffect, useState } from 'react'
import { useTableSort } from '../useTableSort'

const currentYear = new Date().getFullYear()

function MatchBadge({ ok, label }: { ok: boolean | null; label: string }) {
  if (ok === null) return <span style={{ fontSize: 11, color: '#9ca3af' }}>{label}: n/a</span>
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color: ok ? '#166534' : '#991b1b' }}>
      {label}: {ok ? '✓' : '✗'}
    </span>
  )
}

export default function LeadRegistry() {
  const [rows, setRows] = useState<any[]>([])
  const [checking, setChecking] = useState<number | null>(null)
  const [checkingAll, setCheckingAll] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const { search, setSearch, Th, apply } = useTableSort('leadreg', 'name')

  useEffect(() => { load() }, [])

  async function load() {
    const data = await fetch('/api/compliance/lead-registry').then(r => r.json())
    setRows(data)
  }

  async function check(r: any) {
    setChecking(r.id); setError('')
    try {
      const res = await fetch(`/api/compliance/mde/${r.id}`, { method: 'POST' })
      if (!res.ok) { const e = await res.json(); setError(`${r.name}: ${e.error}`) }
      await load()
    } finally { setChecking(null) }
  }

  const monitored = apply(
    rows.filter(r => !r.commercial && !r.lead_not_monitored && (!r.year_built || r.year_built < 1978)),
    r => [r.name, r.address, r.tracking_id, r.registry_owner, r.registry_owner_address, r.cert_number, r.cert_status],
    new Set(['payment_year']),
  )

  async function checkAll() {
    setCheckingAll(true); setError('')
    const errors: string[] = []
    try {
      for (let i = 0; i < monitored.length; i++) {
        const r = monitored[i]
        setProgress(`${i + 1}/${monitored.length} — ${r.name}`)
        setChecking(r.id)
        try {
          const res = await fetch(`/api/compliance/mde/${r.id}`, { method: 'POST' })
          if (!res.ok) { const e = await res.json(); errors.push(`${r.name}: ${e.error}`) }
        } catch (e: any) {
          errors.push(`${r.name}: ${e.message}`)
        }
      }
      if (errors.length) setError(errors.join(' | '))
      await load()
    } finally {
      setChecking(null); setCheckingAll(false); setProgress('')
    }
  }

  return (
    <div>
      <div className="toolbar">
        <h1>Lead Registry (MDE)</h1>
        <input className="filter" style={{ minWidth: 180 }} placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
        <button className="btn btn-primary" onClick={checkAll} disabled={checkingAll}>
          {checkingAll ? `Checking ${progress}…` : '⟳ Check All'}
        </button>
      </div>
      {error && <div className="card" style={{ color: '#991b1b', fontSize: 13 }}>{error}</div>}
      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%' }}>
          <thead>
            <tr>
              <Th col="name">Property</Th><Th col="tracking_id">Tracking ID</Th><Th col="registry_owner">Registry Owner</Th><th>Registry Owner Address</th>
              <Th col="registration_date">Registered</Th><Th col="bank_date">Bank Date</Th><Th col="payment_year">Paid Thru</Th><Th col="cert_status">Cert</Th><th>Units</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {monitored.map(r => {
              const payOk = r.payment_year && Number(r.payment_year) >= currentYear
              return (
                <tr key={r.id}>
                  <td><strong>{r.name}</strong><div style={{ fontSize: 12, color: '#6b7280' }}>{r.address}</div></td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{r.tracking_id || <span style={{color:'#9ca3af'}}>—</span>}</td>
                  <td>
                    {r.registry_owner || <span style={{color:'#9ca3af'}}>—</span>}
                    <div><MatchBadge ok={r.owner_name_match} label="owner" /></div>
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {r.registry_owner_address || <span style={{color:'#9ca3af'}}>—</span>}
                    <div><MatchBadge ok={r.owner_address_match} label="address" /></div>
                  </td>
                  <td>{r.registration_date || <span style={{color:'#9ca3af'}}>—</span>}</td>
                  <td>{r.bank_date || <span style={{color:'#9ca3af'}}>—</span>}</td>
                  <td style={{
                    background: r.payment_year ? (payOk ? '#dcfce7' : '#fee2e2') : '#f3f4f6',
                    color: r.payment_year ? (payOk ? '#166534' : '#991b1b') : '#6b7280',
                    fontWeight: 700, fontSize: 14,
                  }}>
                    {r.payment_year || '—'}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 13 }}>
                    {r.cert_number
                      ? <span style={{ color: (r.cert_status || '').includes('PASS') ? '#166534' : '#991b1b', fontWeight: 600 }}>{r.cert_number} {r.cert_status}</span>
                      : <span style={{color:'#9ca3af'}}>—</span>}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {r.multifamily
                      ? (r.units.length > 0
                          ? r.units.map((u: any) => (
                              <span key={u.unit} title={`${u.cert_number || ''} ${u.inspection_date || ''}`} style={{
                                display: 'inline-block', margin: '1px 2px', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                                background: (u.cert_status || '').includes('PASS') ? '#dcfce7' : '#fee2e2',
                                color: (u.cert_status || '').includes('PASS') ? '#166534' : '#991b1b',
                              }}>{u.unit || '?'}</span>
                            ))
                          : <span style={{color:'#9ca3af'}}>no unit certs</span>)
                      : <span style={{color:'#9ca3af'}}>single</span>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-primary btn-sm" onClick={() => check(r)} disabled={checking === r.id}>
                      {checking === r.id ? '⟳…' : '⟳ Check'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {monitored.length === 0 && <div className="empty">No properties require lead monitoring.</div>}
      </div>
    </div>
  )
}
