import { useEffect, useState } from 'react'

interface Props {
  onSettingsSaved?: () => void
}

export default function Admin({ onSettingsSaved }: Props) {
  const [appName, setAppName] = useState('')
  const [primaryColor, setPrimaryColor] = useState('#3b82f6')
  const [sidebarColor, setSidebarColor] = useState('#0f172a')
  const [logo, setLogo] = useState<string>('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(s => {
      setAppName(s.app_name || '')
      setPrimaryColor(s.primary_color || '#3b82f6')
      setSidebarColor(s.sidebar_color || '#0f172a')
      setLogo(s.logo || '')
    })
  }, [])

  function onLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { setError('Logo must be under 2 MB'); return }
    setError('')
    const reader = new FileReader()
    reader.onload = () => setLogo(reader.result as string)
    reader.readAsDataURL(file)
  }

  async function save() {
    setError(''); setSaved(false)
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_name: appName,
        primary_color: primaryColor,
        sidebar_color: sidebarColor,
        logo,
      }),
    })
    if (!res.ok) { setError('Save failed'); return }
    setSaved(true)
    onSettingsSaved?.()
    setTimeout(() => setSaved(false), 2500)
  }

  return (
    <div>
      <div className="toolbar">
        <h1>Admin</h1>
      </div>
      <div className="card" style={{ maxWidth: 560 }}>
        <h2>Branding</h2>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
          <div className="form-group">
            <label>Application Name</label>
            <input value={appName} onChange={e => setAppName(e.target.value)} placeholder="KRS Property Compliance Monitor" />
          </div>
          <div className="form-group">
            <label>Logo</label>
            {logo && (
              <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
                <img src={logo} alt="logo" style={{ maxHeight: 60, maxWidth: 220, borderRadius: 6, background: '#f3f4f6', padding: 4 }} />
                <button className="btn btn-ghost btn-sm" onClick={() => setLogo('')}>Remove</button>
              </div>
            )}
            <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={onLogoFile} />
            <span style={{ fontSize: 11, color: '#9ca3af' }}>PNG/JPG/SVG, up to 2 MB. Shown in the sidebar.</span>
          </div>
          <div className="form-group">
            <label>Primary Color (buttons, links)</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="color" value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} style={{ width: 48, height: 32, padding: 2 }} />
              <input value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} style={{ width: 110, fontFamily: 'monospace' }} />
            </div>
          </div>
          <div className="form-group">
            <label>Sidebar Color</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="color" value={sidebarColor} onChange={e => setSidebarColor(e.target.value)} style={{ width: 48, height: 32, padding: 2 }} />
              <input value={sidebarColor} onChange={e => setSidebarColor(e.target.value)} style={{ width: 110, fontFamily: 'monospace' }} />
            </div>
          </div>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary" onClick={save}>Save Settings</button>
          {saved && <span style={{ color: '#059669', fontWeight: 600, marginLeft: 10 }}>✓ Saved</span>}
          {error && <span style={{ color: '#991b1b', marginLeft: 10 }}>{error}</span>}
        </div>
      </div>
    </div>
  )
}
