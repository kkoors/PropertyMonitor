import { useEffect, useState, useMemo } from 'react'
import type React from 'react'
import { useLocalState } from '../useLocalState'

const MUNICIPALITIES = [
  { value: 'baltimore_city', label: 'Baltimore City' },
  { value: 'baltimore_county', label: 'Baltimore County' },
  { value: 'harford', label: 'Harford County' },
]

const BLANK = { name: '', address: '', municipality: 'baltimore_city', account_number: '', notes: '', private_ws: false, year_built: '', lead_free: false, lead_free_cert_date: '', lead_free_cert_exp_date: '', owner_name: '', owner_address: '', commercial: false, multifamily: false, lead_not_monitored: false, license_not_monitored: false, tax_id: '', water_mailing_address: '' }

interface Props {
  editPropertyId?: number | null
  onClearEditId?: () => void
  onDoneEditing?: () => void
}

export default function Properties({ editPropertyId, onClearEditId, onDoneEditing }: Props) {
  const [properties, setProperties] = useState<any[]>([])
  const [form, setForm] = useState({ ...BLANK })
  const [editId, setEditId] = useState<number | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [credModal, setCredModal] = useState<number | null>(null)
  const [checking, setChecking] = useState<number | null>(null)
  const [checkResult, setCheckResult] = useState<Record<number, string>>({})
  const [creds, setCreds] = useState({ username: '', password: '' })
  const [storedCreds, setStoredCreds] = useState<any[]>([])
  const [filterMuni, setFilterMuni] = useLocalState('props.filterMuni', '')
  const [showPrivate, setShowPrivate] = useLocalState('props.showPrivate', false)
  const [search, setSearch] = useLocalState('props.search', '')
  const [sortCol, setSortCol] = useLocalState<'name' | 'municipality' | 'account_number' | 'owner_name' | 'tax_id' | 'year_built' | 'private_ws'>('props.sortCol.v2', 'name')
  const [sortDir, setSortDir] = useLocalState<'asc' | 'desc'>('props.sortDir', 'asc')

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (editPropertyId && properties.length > 0) {
      const p = properties.find(x => x.id === editPropertyId)
      if (p) { startEdit(p); onClearEditId?.() }
    }
  }, [editPropertyId, properties])

  async function load() {
    const data = await fetch('/api/properties').then(r => r.json())
    setProperties(data)
  }

  async function save() {
    const method = editId ? 'PUT' : 'POST'
    const url = editId ? `/api/properties/${editId}` : '/api/properties'
    await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      ...form,
      private_ws: form.private_ws ? 1 : 0,
      year_built: form.year_built ? Number(form.year_built) : null,
      lead_free: form.lead_free ? 1 : 0,
      commercial: form.commercial ? 1 : 0,
      multifamily: form.multifamily ? 1 : 0,
      lead_not_monitored: form.lead_not_monitored ? 1 : 0,
      license_not_monitored: form.license_not_monitored ? 1 : 0,
      tax_id: form.tax_id || null,
      water_mailing_address: form.water_mailing_address || null,
      owner_name: form.owner_name || null,
      owner_address: form.owner_address || null,
      lead_free_cert_date: form.lead_free_cert_date || null,
      lead_free_cert_exp_date: form.lead_free_cert_exp_date || null,
    }) })
    setShowForm(false)
    setEditId(null)
    setForm({ ...BLANK })
    load()
    onDoneEditing?.()
  }

  function startEdit(p: any) {
    setForm({ name: p.name, address: p.address, municipality: p.municipality, account_number: p.account_number || '', notes: p.notes || '', private_ws: !!p.private_ws, year_built: p.year_built ? String(p.year_built) : '', lead_free: !!p.lead_free, lead_free_cert_date: p.lead_free_cert_date || '', lead_free_cert_exp_date: p.lead_free_cert_exp_date || '', owner_name: p.owner_name || '', owner_address: p.owner_address || '', commercial: !!p.commercial, multifamily: !!p.multifamily, lead_not_monitored: !!p.lead_not_monitored, license_not_monitored: !!p.license_not_monitored, tax_id: p.tax_id || '', water_mailing_address: p.water_mailing_address || '' })
    setEditId(p.id)
    setShowForm(true)
  }

  async function remove(id: number) {
    if (!confirm('Delete this property and all its bills?')) return
    await fetch(`/api/properties/${id}`, { method: 'DELETE' })
    load()
  }

  async function checkNow(id: number) {
    setChecking(id)
    setCheckResult(r => ({ ...r, [id]: '' }))
    try {
      await fetch(`/api/scrapes/run/${id}`, { method: 'POST' })
      setCheckResult(r => ({ ...r, [id]: 'Checking… refresh in a moment.' }))
      // Reload after a delay to show any new bills
      setTimeout(() => load(), 8000)
    } catch {
      setCheckResult(r => ({ ...r, [id]: 'Request failed.' }))
    } finally {
      setChecking(null)
    }
  }

  async function openCredModal(id: number) {
    setCredModal(id)
    setCreds({ username: '', password: '' })
    const data = await fetch(`/api/properties/${id}/credentials`).then(r => r.json())
    setStoredCreds(data)
  }

  async function saveCreds() {
    await fetch(`/api/properties/${credModal}/credentials`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portal: 'harford', ...creds })
    })
    setCredModal(null)
  }

  function toggleSort(col: typeof sortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const mLabel = (m: string) => MUNICIPALITIES.find(x => x.value === m)?.label || m

  const NUMERIC_COLS = new Set(['year_built', 'private_ws'])

  const q = search.toLowerCase()
  const displayed = properties
    .filter(p => !filterMuni || p.municipality === filterMuni)
    .filter(p => showPrivate || !p.private_ws)
    .filter(p => !q || [p.name, p.address, p.account_number, mLabel(p.municipality)].some(v => v?.toLowerCase().includes(q)))
    .sort((a, b) => {
      const av = a[sortCol] ?? (NUMERIC_COLS.has(sortCol) ? -Infinity : '')
      const bv = b[sortCol] ?? (NUMERIC_COLS.has(sortCol) ? -Infinity : '')
      const cmp = NUMERIC_COLS.has(sortCol) ? Number(av) - Number(bv) : String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? cmp : -cmp
    })

  const Th = ({ col, children }: { col: typeof sortCol; children: React.ReactNode }) => (
    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort(col)} title="Click to sort">
      {children}{sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : <span style={{ opacity: 0.35 }}> ↕</span>}
    </th>
  )

  return (
    <div>
      <div className="toolbar">
        <h1>Properties</h1>
        <input className="filter" style={{ minWidth: 180 }} placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="filter" value={filterMuni} onChange={e => setFilterMuni(e.target.value)}>
          <option value="">All Municipalities</option>
          {MUNICIPALITIES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <button className={`btn btn-sm ${showPrivate ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setShowPrivate(s => !s)}>
          {showPrivate ? 'Hide Private W/S' : 'Show Private W/S'}
        </button>
        <button className="btn btn-primary" onClick={() => { setShowForm(true); setEditId(null); setForm({ ...BLANK }) }}>
          + Add Property
        </button>
      </div>

      {showForm && (
        <div className="card">
          <h2>{editId ? 'Edit Property' : 'Add Property'}</h2>
          <div className="form-grid">
            <div className="form-group">
              <label>Name / Nickname</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Main St Duplex" />
            </div>
            <div className="form-group">
              <label>Municipality</label>
              <select value={form.municipality} onChange={e => setForm(f => ({ ...f, municipality: e.target.value }))}>
                {MUNICIPALITIES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div className="form-group full-col">
              <label>Service Address</label>
              <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} placeholder="123 Main St" />
            </div>
            <div className="form-group">
              <label>Water Account Number</label>
              <input value={form.account_number} onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))} placeholder="Water/sewer billing account" />
            </div>
            <div className="form-group">
              <label>Tax ID (SDAT Account)</label>
              <input value={form.tax_id} onChange={e => setForm(f => ({ ...f, tax_id: e.target.value }))} placeholder="Auto-filled by Tax Address check" />
            </div>
            <div className="form-group full-col">
              <label>Water Bill Mailing Address</label>
              <input value={form.water_mailing_address} onChange={e => setForm(f => ({ ...f, water_mailing_address: e.target.value }))} placeholder="Where the water bill is mailed" />
            </div>
            <div className="form-group">
              <label>Notes</label>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>Owner Name</label>
              <input value={form.owner_name} onChange={e => setForm(f => ({ ...f, owner_name: e.target.value }))} placeholder="Legal owner (as on deed/MDE)" />
            </div>
            <div className="form-group full-col">
              <label>Owner Address</label>
              <input value={form.owner_address} onChange={e => setForm(f => ({ ...f, owner_address: e.target.value }))} placeholder="Owner mailing address (not the property address)" />
            </div>
            <div className="form-group" style={{ justifyContent: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                <input type="checkbox" checked={form.commercial} onChange={e => setForm(f => ({ ...f, commercial: e.target.checked }))} />
                Commercial
              </label>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>No rental license or lead compliance needed</span>
            </div>
            <div className="form-group" style={{ justifyContent: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                <input type="checkbox" checked={form.multifamily} onChange={e => setForm(f => ({ ...f, multifamily: e.target.checked }))} />
                Multifamily
              </label>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>Pull lead certs for every unit</span>
            </div>
            <div className="form-group" style={{ justifyContent: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                <input type="checkbox" checked={form.lead_not_monitored} onChange={e => setForm(f => ({ ...f, lead_not_monitored: e.target.checked }))} />
                Lead Not Monitored
              </label>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>Not rented — skip lead compliance</span>
            </div>
            <div className="form-group" style={{ justifyContent: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                <input type="checkbox" checked={form.license_not_monitored} onChange={e => setForm(f => ({ ...f, license_not_monitored: e.target.checked }))} />
                License Not Monitored
              </label>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>Not rented — skip rental license</span>
            </div>
            <div className="form-group">
              <label>Year Built</label>
              <input type="number" min="1800" max="2030" value={form.year_built} onChange={e => setForm(f => ({ ...f, year_built: e.target.value }))} placeholder="e.g. 1965" />
            </div>
            <div className="form-group" style={{ justifyContent: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                <input type="checkbox" checked={form.private_ws} onChange={e => setForm(f => ({ ...f, private_ws: e.target.checked }))} />
                Private W/S
              </label>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>Skip bill monitoring for this property</span>
            </div>
            <div className="form-group" style={{ justifyContent: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                <input type="checkbox" checked={form.lead_free} onChange={e => setForm(f => ({ ...f, lead_free: e.target.checked }))} />
                Lead-Free Certified
              </label>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>Property is certified lead-free</span>
            </div>
            {form.lead_free && (<>
              <div className="form-group">
                <label>Lead-Free Cert Date</label>
                <input type="date" value={form.lead_free_cert_date} onChange={e => setForm(f => ({ ...f, lead_free_cert_date: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Lead-Free Cert Expiration</label>
                <input type="date" value={form.lead_free_cert_exp_date} onChange={e => setForm(f => ({ ...f, lead_free_cert_exp_date: e.target.value }))} />
              </div>
            </>)}
          </div>
          <div className="form-actions">
            <button className="btn btn-primary" onClick={save}>Save</button>
            <button className="btn btn-ghost" onClick={() => { setShowForm(false); onDoneEditing?.() }}>Cancel</button>
          </div>
        </div>
      )}

      {properties.length === 0 && !showForm ? (
        <div className="card"><div className="empty">No properties yet. Add one to get started.</div></div>
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <Th col="name">Name</Th>
                <th>Address</th>
                <Th col="municipality">Municipality</Th>
                <Th col="account_number">Water Acct #</Th>
                <Th col="owner_name">Owner</Th>
                <Th col="tax_id">Tax ID</Th>
                <Th col="year_built">Year Built</Th>
                {showPrivate && <Th col="private_ws">Private W/S</Th>}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map(p => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong></td>
                  <td style={{ color: '#6b7280' }}>{p.address}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{mLabel(p.municipality)}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{p.account_number || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                  <td>{p.owner_name || <span style={{color:'#9ca3af'}}>—</span>}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{p.tax_id || <span style={{color:'#9ca3af'}}>—</span>}</td>
                  <td>{p.year_built || <span style={{color:'#9ca3af'}}>—</span>}</td>
                  {showPrivate && <td style={{ textAlign: 'center' }}>{p.private_ws ? '✓' : ''}</td>}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-primary btn-sm" onClick={() => checkNow(p.id)} disabled={checking === p.id || !!p.private_ws} title={p.private_ws ? 'Private W/S — monitoring disabled' : 'Check for a new bill now'} style={{marginRight:4}}>
                      {checking === p.id ? '⟳…' : '⟳ Check'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => startEdit(p)} style={{marginRight:4}}>Edit</button>

                    <button className="btn btn-danger btn-sm" onClick={() => remove(p.id)}>Del</button>
                    {checkResult[p.id] && (
                      <div style={{ fontSize: 11, color: '#2563eb', marginTop: 4 }}>{checkResult[p.id]}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {credModal !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div className="card" style={{ width: 400, margin: 0 }}>
            <h2>Harford County Portal Credentials</h2>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
              Stored encrypted. Used by the scraper to log in to wspayments.harfordcountymd.gov.
            </p>
            {storedCreds.length > 0 && (
              <p style={{ fontSize: 13, color: '#059669', marginBottom: 10 }}>
                ✓ Credentials already saved (portal: {storedCreds[0].portal}, saved {new Date(storedCreds[0].created_at).toLocaleDateString()})
              </p>
            )}
            <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="form-group">
                <label>Username</label>
                <input value={creds.username} onChange={e => setCreds(c => ({ ...c, username: e.target.value }))} placeholder="Portal username" />
              </div>
              <div className="form-group">
                <label>Password</label>
                <input type="password" value={creds.password} onChange={e => setCreds(c => ({ ...c, password: e.target.value }))} placeholder="Portal password" />
              </div>
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={saveCreds} disabled={!creds.username || !creds.password}>Save Credentials</button>
              <button className="btn btn-ghost" onClick={() => setCredModal(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
