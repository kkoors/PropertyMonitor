import { useEffect, useState } from 'react'
import { useTableSort } from '../useTableSort'
import { downloadExcel, cell, dateCell } from '../excel'

const currentYear = new Date().getFullYear()

function MatchBadge({ ok, label }: { ok: boolean | null; label: string }) {
  if (ok === null) return <span style={{ fontSize: 11, color: '#9ca3af' }}>{label}: n/a</span>
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color: ok ? '#166534' : '#991b1b' }}>
      {label}: {ok ? '✓' : '✗'}
    </span>
  )
}

export default function LeadRegistry({ onEditProperty }: { onEditProperty?: (id: number) => void }) {
  const [rows, setRows] = useState<any[]>([])
  const [checking, setChecking] = useState<number | null>(null)
  const [checkingAll, setCheckingAll] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const { search, setSearch, Th, apply } = useTableSort('leadreg', 'name')

  useEffect(() => { load() }, [])

  async function load() {
    const data = await fetch('/api/compliance/lead-registry').then(r => r.json())
    setRows(data)
  }

  async function toggleHide(r: any, unit: string, hidden: boolean) {
    await fetch(`/api/compliance/lead-unit-hide/${r.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit, hidden }),
    })
    await load()
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

  // Mirrors the table: multifamily properties expand to one row per unit cert,
  // honouring the "show hidden units" toggle.
  function exportExcel() {
    downloadExcel('lead-registry', 'Lead Registry', monitored.flatMap(r => {
      const visibleUnits = showHidden ? r.units : r.units.filter((u: any) => !u.hidden)
      const units: any[] = (r.multifamily && visibleUnits.length > 0)
        ? visibleUnits
        : [{ unit: '', cert_number: r.cert_number, cert_status: r.cert_status, inspection_date: r.inspection_date }]
      return units.map((u: any) => ({
        Property: r.name,
        Address: cell(r.address),
        'Tracking ID': cell(r.tracking_id),
        'Registry Owner': cell(r.registry_owner),
        'Owner Matches': r.owner_name_match == null ? '' : r.owner_name_match ? 'Yes' : 'No',
        'Registry Owner Address': cell(r.registry_owner_address),
        'Address Matches': r.owner_address_match == null ? '' : r.owner_address_match ? 'Yes' : 'No',
        Registered: dateCell(r.registration_date),
        'Bank Date': dateCell(r.bank_date),
        'Paid Thru': cell(r.payment_year),
        Unit: cell(u.unit),
        'Cert #': cell(u.cert_number),
        Cert: cell(u.cert_status),
        Inspected: dateCell(u.inspection_date),
        Hidden: u.hidden ? 'Yes' : '',
      }))
    }))
  }

  return (
    <div>
      <div className="toolbar">
        <h1>Lead Registry (MDE)</h1>
        <input className="filter" style={{ minWidth: 180 }} placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
        <button className="btn btn-ghost" onClick={exportExcel} title="Download this list to Excel">⬇ Excel</button>
        <button className={`btn btn-sm ${showHidden ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setShowHidden(s => !s)}>
          {showHidden ? 'Hide hidden units' : 'Show hidden units'}
        </button>
        <button className="btn btn-primary" onClick={checkAll} disabled={checkingAll}>
          {checkingAll ? `Checking ${progress}…` : '⟳ Check All'}
        </button>
      </div>
      {error && <div className="card" style={{ color: '#991b1b', fontSize: 13 }}>{error}</div>}
      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 'max-content' }}>
          <thead>
            <tr>
              <Th col="name">Property</Th><Th col="tracking_id">Tracking ID</Th><Th col="registry_owner">Registry Owner</Th><th>Registry Owner Address</th>
              <Th col="registration_date">Registered</Th><Th col="bank_date">Bank Date</Th><Th col="payment_year">Paid Thru</Th>
              <th>Unit</th><Th col="cert_status">Cert</Th><th>Inspected</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {monitored.flatMap(r => {
              const payOk = r.payment_year && Number(r.payment_year) >= currentYear
              // Multifamily with unit certs → one row per unit; otherwise a single row from the property-level cert
              const visibleUnits = showHidden ? r.units : r.units.filter((u: any) => !u.hidden)
              const units: any[] = (r.multifamily && visibleUnits.length > 0)
                ? visibleUnits
                : [{ unit: r.multifamily ? '?' : '', cert_number: r.cert_number, cert_status: r.cert_status, inspection_date: r.inspection_date, has_pdf: r.has_cert_pdf, nohide: true, propertyLevel: true }]
              const span = units.length
              return units.map((u: any, i: number) => (
                <tr key={`${r.id}-${u.unit ?? i}`}>
                  {i === 0 && (<>
                    <td rowSpan={span}>
                      <button className="btn btn-ghost btn-sm" style={{ fontWeight: 700, fontSize: 14, padding: '2px 6px', textAlign: 'left' }} onClick={() => onEditProperty?.(r.id)} title="Edit property">
                        {r.name}
                      </button>
                      <div style={{ fontSize: 12, color: '#6b7280', paddingLeft: 6, cursor: 'pointer' }} onClick={() => onEditProperty?.(r.id)} title="Edit property">{r.address}</div>
                    </td>
                    <td rowSpan={span} style={{ fontFamily: 'monospace', fontSize: 13 }}>{r.tracking_id || <span style={{color:'#9ca3af'}}>—</span>}</td>
                    <td rowSpan={span}>
                      {r.registry_owner || <span style={{color:'#9ca3af'}}>—</span>}
                      <div><MatchBadge ok={r.owner_name_match} label="owner" /></div>
                    </td>
                    <td rowSpan={span} style={{ fontSize: 13 }}>
                      {r.registry_owner_address || <span style={{color:'#9ca3af'}}>—</span>}
                      <div><MatchBadge ok={r.owner_address_match} label="address" /></div>
                    </td>
                    <td rowSpan={span}>{r.registration_date || <span style={{color:'#9ca3af'}}>—</span>}</td>
                    <td rowSpan={span}>{r.bank_date || <span style={{color:'#9ca3af'}}>—</span>}</td>
                    <td rowSpan={span} style={{
                      background: r.payment_year ? (payOk ? '#dcfce7' : '#fee2e2') : '#f3f4f6',
                      color: r.payment_year ? (payOk ? '#166534' : '#991b1b') : '#6b7280',
                      fontWeight: 700, fontSize: 14,
                    }}>
                      {r.payment_year || '—'}
                    </td>
                  </>)}
                  <td style={{ fontWeight: 700, whiteSpace: 'nowrap', opacity: u.hidden ? 0.45 : 1 }}>
                    {r.multifamily ? (u.unit || '?') : <span style={{color:'#9ca3af'}}>—</span>}
                    {r.multifamily && !u.nohide && (
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ marginLeft: 6, padding: '0 5px', fontSize: 11 }}
                        title={u.hidden ? 'Unhide this unit' : 'Hide this unit (stale MDE entry)'}
                        onClick={() => toggleHide(r, u.unit || '', !u.hidden)}
                      >
                        {u.hidden ? '👁 unhide' : '🚫'}
                      </button>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 13, opacity: u.hidden ? 0.45 : 1 }}>
                    {u.cert_number
                      ? <span style={{ color: (u.cert_status || '').includes('PASS') ? '#166534' : '#991b1b', fontWeight: 600 }}>{u.cert_number} {u.cert_status}</span>
                      : <span style={{color:'#9ca3af'}}>{r.multifamily ? 'no cert' : '—'}</span>}
                    {u.has_pdf ? (
                      <a
                        href={`/api/compliance/lead-cert-pdf/${r.id}${u.propertyLevel ? '' : `?unit=${encodeURIComponent(u.unit || '')}`}`}
                        target="_blank" rel="noreferrer" title="View certificate PDF" style={{ marginLeft: 6 }}
                      >📄</a>
                    ) : null}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 13, opacity: u.hidden ? 0.45 : 1 }}>{u.inspection_date || <span style={{color:'#9ca3af'}}>—</span>}</td>
                  {i === 0 && (
                    <td rowSpan={span} style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-primary btn-sm" onClick={() => check(r)} disabled={checking === r.id}>
                        {checking === r.id ? '⟳…' : '⟳ Check'}
                      </button>
                    </td>
                  )}
                </tr>
              ))
            })}
          </tbody>
        </table>
        {monitored.length === 0 && <div className="empty">No properties require lead monitoring.</div>}
      </div>
    </div>
  )
}
