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
  const [discovering, setDiscovering] = useState(false)
  const [notice, setNotice] = useState('')
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

  // Matches Baltimore City properties to their DHCD (OpenGov) location IDs so
  // license checks read the live system instead of the lagging GIS extract.
  async function discoverIds() {
    setDiscovering(true); setError(''); setNotice('')
    try {
      const res = await fetch('/api/compliance/opengov-discover', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Discovery failed'); return }
      const missed = data.unmatched?.length
        ? ` ${data.unmatched.length} not found in DHCD: ${data.unmatched.map((u: any) => u.name).join(', ')}`
        : ''
      setNotice(`Linked ${data.matched.length} propert${data.matched.length === 1 ? 'y' : 'ies'} to DHCD records.${missed}`)
      await load()
    } catch (e: any) { setError(e.message) } finally { setDiscovering(false) }
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
        <button className="btn btn-ghost" onClick={discoverIds} disabled={discovering}
          title="Match Baltimore City properties to their DHCD portal records automatically">
          {discovering ? 'Linking…' : '🔗 Link DHCD Records'}
        </button>
        <button className="btn btn-primary" onClick={checkAll} disabled={checkingAll}>
          {checkingAll ? 'Checking…' : '⟳ Check All'}
        </button>
      </div>
      {notice && <div className="card" style={{ color: '#166534', fontSize: 13 }}>{notice}</div>}
      {error && <div className="card" style={{ color: '#991b1b', fontSize: 13 }}>{error}</div>}
      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 'max-content' }}>
          <thead>
            <tr>
              <Th col="name">Property</Th><th>Address</th><Th col="municipality">Municipality</Th>
              <Th col="license_number">License #</Th><Th col="status">License</Th><Th col="issue_date">Issued</Th><Th col="exp_date">Expires</Th>
              <Th col="reg_status">Registration</Th><Th col="reg_exp_date">Reg Expires</Th>
              <th>Letter</th><Th col="scraped_at">Last Checked</Th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {monitored.flatMap(r => {
              const lics: any[] = r.licenses && r.licenses.length > 0 ? r.licenses : [null]
              const span = lics.length
              return lics.map((l: any, i: number) => {
                const lic = l || r // single/never-checked rows fall back to flat fields
                return (
                  <tr key={`${r.id}-${l?.unit ?? i}`}>
                    {i === 0 && (<>
                      <td rowSpan={span}>
                        <button className="btn btn-ghost btn-sm" style={{ fontWeight: 700, fontSize: 14, padding: '2px 6px', textAlign: 'left' }} onClick={() => onEditProperty?.(r.id)} title="Edit property">
                          {r.name}
                        </button>
                      </td>
                      <td rowSpan={span} style={{ color: '#6b7280', cursor: 'pointer' }} onClick={() => onEditProperty?.(r.id)} title="Edit property">{r.address}</td>
                      <td rowSpan={span} style={{ whiteSpace: 'nowrap' }}>{r.municipality === 'baltimore_city' ? 'Baltimore City' : 'Baltimore County'}</td>
                    </>)}
                    <td style={{ fontFamily: 'monospace', fontSize: 13, whiteSpace: 'nowrap' }}>
                      {span > 1 && <span style={{ fontFamily: 'inherit', fontWeight: 700, marginRight: 6 }}>Unit {l.unit || '?'}</span>}
                      {lic.license_number || <span style={{color:'#9ca3af'}}>—</span>}
                      {(lic.notes || r.license_url)?.startsWith?.('http') && (
                        <a href={lic.notes || r.license_url} target="_blank" rel="noreferrer" title="Open DHCD portal record" style={{ marginLeft: 5 }}>↗</a>
                      )}
                    </td>
                    <td style={{ background: STATUS_BG[lic.status] || '#f3f4f6', color: STATUS_TEXT[lic.status] || '#6b7280', fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap' }}>
                      {lic.status ? String(lic.status).replace('_', ' ') : 'never checked'}
                    </td>
                    <td>{lic.issue_date || <span style={{color:'#9ca3af'}}>—</span>}</td>
                    <td>{lic.exp_date || <span style={{color:'#9ca3af'}}>—</span>}</td>
                    {i === 0 && (<>
                      <td rowSpan={span} style={{
                        background: r.municipality === 'baltimore_city' ? (STATUS_BG[r.reg_status] || '#f3f4f6') : undefined,
                        color: r.municipality === 'baltimore_city' ? (STATUS_TEXT[r.reg_status] || '#6b7280') : '#9ca3af',
                        fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap',
                      }}>
                        {r.municipality === 'baltimore_city' ? (r.reg_status ? r.reg_status.replace('_', ' ') : 'never checked') : 'n/a'}
                      </td>
                      <td rowSpan={span}>
                        {r.municipality === 'baltimore_city' ? (<>
                          {r.reg_exp_date || <span style={{color:'#9ca3af'}}>—</span>}
                          {r.reg_url && <a href={r.reg_url} target="_blank" rel="noreferrer" title="Open DHCD portal record" style={{ marginLeft: 5 }}>↗</a>}
                        </>) : <span style={{color:'#9ca3af'}}>—</span>}
                      </td>
                      <td rowSpan={span}>{r.has_letter ? <a href={`/api/compliance/rental-license/letter/${r.id}/${r.municipality}`} target="_blank" rel="noreferrer">📄</a> : <span style={{color:'#9ca3af'}}>—</span>}</td>
                      <td rowSpan={span} style={{ fontSize: 12, color: '#6b7280' }}>{r.scraped_at ? r.scraped_at.slice(0, 10) : '—'}</td>
                      <td rowSpan={span} style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn btn-primary btn-sm" onClick={() => check(r)} disabled={checking === r.id}>
                          {checking === r.id ? '⟳…' : '⟳ Check'}
                        </button>
                      </td>
                    </>)}
                  </tr>
                )
              })
            })}
          </tbody>
        </table>
        {monitored.length === 0 && <div className="empty">No properties require rental licensing.</div>}
      </div>
    </div>
  )
}
