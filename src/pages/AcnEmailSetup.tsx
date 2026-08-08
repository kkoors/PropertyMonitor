import { useEffect, useState } from 'react'

const PLACEHOLDERS = [
  'property_name', 'address', 'account_number', 'owner_name', 'owner_address',
  'municipality', 'tax_id', 'today',
]

type Template = { to: string, cc: string, subject: string, body: string }

export default function AcnEmailSetup() {
  const [templates, setTemplates] = useState<Record<string, Template>>({})
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')
  const [properties, setProperties] = useState<any[]>([])
  const [previewId, setPreviewId] = useState('')
  const [preview, setPreview] = useState<any>(null)

  useEffect(() => {
    fetch('/api/acn/templates').then(r => r.json()).then(setTemplates)
    fetch('/api/properties').then(r => r.json()).then(d => Array.isArray(d) && setProperties(d))
  }, [])

  function update(kind: string, field: keyof Template, value: string) {
    setTemplates(t => ({ ...t, [kind]: { ...t[kind], [field]: value } }))
  }

  async function save(kind: string) {
    setError(''); setSaved('')
    const res = await fetch(`/api/acn/templates/${kind}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(templates[kind]),
    })
    if (!res.ok) { setError((await res.json()).error || 'Save failed'); return }
    setSaved(`${kind === 'enroll' ? 'Enrollment' : 'Disenrollment'} email saved`)
    setTimeout(() => setSaved(''), 2500)
  }

  // Renders the template against a real property so the placeholders can be
  // checked before anything is sent.
  async function showPreview(kind: string) {
    if (!previewId) { setError('Pick a property to preview against'); return }
    setError('')
    const res = await fetch(`/api/acn/preview/${kind}/${previewId}`)
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Preview failed'); return }
    setPreview({ kind, ...data })
  }

  function card(kind: 'enroll' | 'disenroll', title: string, blurb: string) {
    const t = templates[kind]
    if (!t) return null
    return (
      <div className="card" key={kind}>
        <h2>{title}</h2>
        <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0 }}>{blurb}</p>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
          <div className="form-group">
            <label>Recipient</label>
            <input value={t.to} onChange={e => update(kind, 'to', e.target.value)} placeholder="utility@example.com (comma separated for several)" />
          </div>
          <div className="form-group">
            <label>CC (optional)</label>
            <input value={t.cc} onChange={e => update(kind, 'cc', e.target.value)} placeholder="office@example.com" />
          </div>
          <div className="form-group">
            <label>Subject</label>
            <input value={t.subject} onChange={e => update(kind, 'subject', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Body (HTML)</label>
            <textarea value={t.body} onChange={e => update(kind, 'body', e.target.value)}
              style={{ width: '100%', height: 190, padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, fontFamily: 'monospace', resize: 'vertical' }} />
          </div>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary" onClick={() => save(kind)}>Save</button>
          <button className="btn btn-ghost" onClick={() => showPreview(kind)}>Preview</button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="toolbar"><h1>ACN Email Setup</h1></div>

      <div className="card" style={{ fontSize: 13 }}>
        <strong>Placeholders</strong> — these are replaced with the property's details when the email is sent:
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {PLACEHOLDERS.map(p => (
            <code key={p} style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: 4 }}>{`{{${p}}}`}</code>
          ))}
        </div>
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#6b7280' }}>Preview against:</span>
          <select className="filter" value={previewId} onChange={e => setPreviewId(e.target.value)}>
            <option value="">Select a property…</option>
            {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      {saved && <div className="card" style={{ color: '#166534', fontSize: 13 }}>{saved}</div>}
      {error && <div className="card" style={{ color: '#991b1b', fontSize: 13 }}>{error}</div>}

      {card('enroll', 'Enrollment Email', 'Sent by the Enroll button on the ACN Program page. The property moves to Pending Enrollment once it sends.')}
      {card('disenroll', 'Disenrollment Email', 'Sent by the Disenroll button for enrolled properties. The property moves to Pending Disenrollment once it sends.')}

      {preview && (
        <div className="card">
          <h2>Preview — {preview.kind === 'enroll' ? 'Enrollment' : 'Disenrollment'}</h2>
          <div style={{ fontSize: 13, color: '#6b7280' }}>
            <div><strong>To:</strong> {preview.to || <span style={{ color: '#991b1b' }}>no recipient configured</span>}</div>
            {preview.cc && <div><strong>CC:</strong> {preview.cc}</div>}
            <div><strong>Subject:</strong> {preview.subject}</div>
          </div>
          <div style={{ marginTop: 10, padding: 12, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' }}
            dangerouslySetInnerHTML={{ __html: preview.html }} />
          <div className="form-actions"><button className="btn btn-ghost" onClick={() => setPreview(null)}>Close</button></div>
        </div>
      )}
    </div>
  )
}
