import { useEffect, useState } from 'react'
import { useTableSort } from '../useTableSort'

const FLAG_BG: Record<string, string> = { green: '#dcfce7', yellow: '#fef9c3', red: '#fee2e2', unknown: '#f3f4f6' }
const FLAG_TEXT: Record<string, string> = { green: '#166534', yellow: '#854d0e', red: '#991b1b', unknown: '#6b7280' }

export default function TaxAddress({ onEditProperty }: { onEditProperty?: (id: number) => void }) {
  const [rows, setRows] = useState<any[]>([])
  const [checking, setChecking] = useState<number | null>(null)
  const [checkingAll, setCheckingAll] = useState(false)
  const [error, setError] = useState('')
  const { search, setSearch, Th, apply } = useTableSort('taxaddr', 'name')

  useEffect(() => { load() }, [])

  async function load() {
    const data = await fetch('/api/compliance/tax-address').then(r => r.json())
    setRows(data)
  }

  async function check(r: any) {
    setChecking(r.id); setError('')
    try {
      const res = await fetch(`/api/compliance/tax-address/${r.id}`, { method: 'POST' })
      if (!res.ok) { const e = await res.json(); setError(`${r.name}: ${e.error}`) }
      await load()
    } finally { setChecking(null) }
  }

  async function checkAll() {
    setCheckingAll(true); setError('')
    try {
      await fetch('/api/compliance/tax-address-all', { method: 'POST' })
      await load()
    } finally { setCheckingAll(false) }
  }

  return (
    <div>
      <div className="toolbar">
        <h1>Tax Mailing Address (SDAT)</h1>
        <input className="filter" style={{ minWidth: 180 }} placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
        <button className="btn btn-primary" onClick={checkAll} disabled={checkingAll}>
          {checkingAll ? 'Checking…' : '⟳ Check All'}
        </button>
      </div>
      <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 12px 4px' }}>
        Flags properties whose SDAT mailing address points at the rental itself or doesn't match the owner address on file — tax bills would go to the wrong place.
      </p>
      {error && <div className="card" style={{ color: '#991b1b', fontSize: 13 }}>{error}</div>}
      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 'max-content' }}>
          <thead>
            <tr>
              <Th col="name">Property</Th><Th col="tax_id">Tax ID</Th><th>Owner Address (on file)</th><th>SDAT Mailing Address</th><Th col="flagStatus">Status</Th><Th col="sdat_checked_at">Checked</Th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {apply(
              rows,
              r => [r.name, r.address, r.tax_id, r.owner_address, r.sdat_mailing_address, r.flag?.label],
              new Set(),
              (r, col) => col === 'flagStatus' ? r.flag?.status : r[col],
            ).map(r => (
              <tr key={r.id}>
                <td>
                  <button className="btn btn-ghost btn-sm" style={{ fontWeight: 700, fontSize: 14, padding: '2px 6px', textAlign: 'left' }} onClick={() => onEditProperty?.(r.id)} title="Edit property">
                    {r.name}
                  </button>
                  <div style={{ fontSize: 12, color: '#6b7280', paddingLeft: 6, cursor: 'pointer' }} onClick={() => onEditProperty?.(r.id)} title="Edit property">{r.address}</div>
                </td>
                <td style={{ fontFamily: 'monospace', fontSize: 13, whiteSpace: 'nowrap' }}>
                  {r.tax_id ? (<>
                    {r.tax_id}
                    {r.tax_id.length >= 8 && (
                      <a
                        href={`https://sdat.dat.maryland.gov/RealProperty/Pages/viewdetails.aspx?County=${r.tax_id.slice(0, 2)}&SearchType=ACCT&District=${r.tax_id.slice(2, 4)}&AccountNumber=${r.tax_id.slice(4)}`}
                        target="_blank" rel="noreferrer" title="Open authoritative SDAT record" style={{ marginLeft: 6 }}
                      >↗</a>
                    )}
                  </>) : <span style={{color:'#9ca3af'}}>—</span>}
                </td>
                <td style={{ fontSize: 13 }}>{r.owner_address || <span style={{color:'#9ca3af'}}>none on file</span>}</td>
                <td style={{ fontSize: 13 }}>{r.sdat_mailing_address || <span style={{color:'#9ca3af'}}>—</span>}</td>
                <td style={{ background: FLAG_BG[r.flag.status], color: FLAG_TEXT[r.flag.status], fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap' }}>
                  {r.flag.label}
                </td>
                <td style={{ fontSize: 12, color: '#6b7280' }}>{r.sdat_checked_at ? r.sdat_checked_at.slice(0, 10) : '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn btn-primary btn-sm" onClick={() => check(r)} disabled={checking === r.id}>
                    {checking === r.id ? '⟳…' : '⟳ Check'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
