import { useState } from 'react'

interface LookupResult {
  input: string
  matched: boolean
  matched_address?: string
  municipality?: string
  municipality_label?: string
  supported?: boolean
  county_name?: string
  error?: string
  selected?: boolean
  duplicate?: { id: number; name: string; address: string } | null
}

const MUNI_OPTIONS = [
  { value: 'baltimore_city',   label: 'Baltimore City' },
  { value: 'baltimore_county', label: 'Baltimore County' },
  { value: 'harford',          label: 'Harford County' },
]

export default function AddressLookup({ onAddProperties }: { onAddProperties?: () => void }) {
  const [text, setText] = useState('')
  const [results, setResults] = useState<LookupResult[]>([])
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addedCount, setAddedCount] = useState(0)
  const [error, setError] = useState('')

  async function lookup() {
    const addresses = text.split('\n').map(l => l.trim()).filter(Boolean)
    if (!addresses.length) return
    setLoading(true)
    setResults([])
    setAddedCount(0)
    setError('')
    try {
      const res = await fetch('/api/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses }),
      })
      if (!res.ok) throw new Error(`Server error ${res.status}: ${await res.text()}`)
      const data: LookupResult[] = await res.json()
      setResults(data.map(r => ({ ...r, selected: r.supported && !r.duplicate })))
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function toggle(i: number) {
    setResults(rs => rs.map((r, idx) => idx === i ? { ...r, selected: !r.selected } : r))
  }

  function setMuni(i: number, municipality: string) {
    const label = MUNI_OPTIONS.find(m => m.value === municipality)?.label || ''
    setResults(rs => rs.map((r, idx) =>
      idx === i ? { ...r, municipality, municipality_label: label, supported: true } : r
    ))
  }

  async function addSelected() {
    const toAdd = results.filter(r => r.selected && r.municipality)
    if (!toAdd.length) return
    setAdding(true)
    let count = 0
    for (const r of toAdd) {
      const address = r.matched_address || r.input
      const name = deriveNickname(address)
      await fetch('/api/properties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, address, municipality: r.municipality }),
      })
      count++
    }
    setAddedCount(count)
    setAdding(false)
    // Unselect added rows
    setResults(rs => rs.map(r => r.selected ? { ...r, selected: false } : r))
    onAddProperties?.()
  }

  const selectedCount = results.filter(r => r.selected).length

  return (
    <div>
      <div className="toolbar"><h1>Address Lookup</h1></div>

      <div className="card">
        <h2>Paste Addresses</h2>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 10 }}>
          One address per line. The Census geocoder will identify the municipality.
        </p>
        <textarea
          className="form-group"
          style={{ width: '100%', height: 140, padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 14, fontFamily: 'monospace', resize: 'vertical' }}
          placeholder={"123 Main St, Baltimore, MD 21201\n456 Oak Ave, Towson, MD 21204\n789 Elm St, Bel Air, MD 21014"}
          value={text}
          onChange={e => setText(e.target.value)}
        />
        <div className="form-actions" style={{ marginTop: 8 }}>
          <button className="btn btn-primary" onClick={lookup} disabled={loading || !text.trim()}>
            {loading ? 'Looking up…' : 'Look Up Municipalities'}
          </button>
          {results.length > 0 && (
            <button className="btn btn-ghost" onClick={() => { setResults([]); setAddedCount(0); setError('') }}>
              Clear
            </button>
          )}
        </div>
        {error && (
          <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#b91c1c', fontSize: 13 }}>
            {error}
          </div>
        )}
      </div>

      {results.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12, gap: 12 }}>
            <h2 style={{ margin: 0, flex: 1 }}>Results ({results.length})</h2>
            {selectedCount > 0 && (
              <button className="btn btn-primary" onClick={addSelected} disabled={adding}>
                {adding ? 'Adding…' : `Add ${selectedCount} to Properties`}
              </button>
            )}
            {addedCount > 0 && (
              <span style={{ fontSize: 13, color: '#059669', fontWeight: 600 }}>
                ✓ {addedCount} added
              </span>
            )}
          </div>

          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}></th>
                <th>Input Address</th>
                <th>Matched Address</th>
                <th>Municipality</th>
                <th>Duplicate</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} style={{ opacity: r.matched === false ? 0.6 : 1 }}>
                  <td>
                    {r.matched && (
                      <input
                        type="checkbox"
                        checked={!!r.selected}
                        onChange={() => toggle(i)}
                        style={{ cursor: 'pointer' }}
                      />
                    )}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{r.input}</td>
                  <td style={{ fontSize: 13, color: '#374151' }}>
                    {r.error
                      ? <span style={{ color: '#ef4444' }}>Error: {r.error}</span>
                      : r.matched
                        ? r.matched_address
                        : <span style={{ color: '#9ca3af' }}>No match found</span>
                    }
                  </td>
                  <td>
                    {r.matched && (
                      r.supported
                        ? <MuniBadge m={r.municipality!} label={r.municipality_label!} />
                        : <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 12, color: '#9ca3af' }}>
                              {r.county_name || 'Unsupported county'}
                            </span>
                            <select
                              className="filter"
                              style={{ fontSize: 12 }}
                              defaultValue=""
                              onChange={e => e.target.value && setMuni(i, e.target.value)}
                            >
                              <option value="">Override…</option>
                              {MUNI_OPTIONS.map(m => (
                                <option key={m.value} value={m.value}>{m.label}</option>
                              ))}
                            </select>
                          </div>
                    )}
                  </td>
                  <td>
                    {r.duplicate
                      ? <span title={`Existing: ${r.duplicate.address}`} style={{ fontSize: 12, color: '#b45309', fontWeight: 600, cursor: 'help' }}>
                          ⚠ Already added as "{r.duplicate.name}"
                        </span>
                      : r.matched
                        ? <span style={{ fontSize: 12, color: '#6b7280' }}>—</span>
                        : null
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function MuniBadge({ m, label }: { m: string; label: string }) {
  const cls = { baltimore_city: 'badge-city', baltimore_county: 'badge-county', harford: 'badge-harford' }[m] || ''
  return <span className={`badge ${cls}`}>{label}</span>
}

function deriveNickname(address: string) {
  // Use the street number + street name as a short nickname
  return address.split(',')[0].trim()
}
