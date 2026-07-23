import { useEffect, useState } from 'react'

export default function ScrapeHistory() {
  const [runs, setRuns] = useState<any[]>([])
  const [selected, setSelected] = useState<any>(null)

  useEffect(() => { load() }, [])

  async function load() {
    const data = await fetch('/api/scrapes').then(r => r.json())
    setRuns(data)
  }

  async function loadRun(id: number) {
    const data = await fetch(`/api/scrapes/${id}`).then(r => r.json())
    setSelected(data)
  }

  return (
    <div>
      <div className="toolbar"><h1>Scrape History</h1></div>
      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ padding: 0 }}>
          {runs.length === 0 ? (
            <div className="empty">No scrape runs yet.</div>
          ) : (
            <table>
              <thead><tr><th>Started</th><th>By</th><th>Bills</th><th>Errors</th></tr></thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => loadRun(r.id)}>
                    <td style={{ fontSize: 12 }}>{new Date(r.started_at).toLocaleString()}</td>
                    <td><span className="badge badge-new" style={{ fontSize: 11 }}>{r.triggered_by}</span></td>
                    <td>{r.bills_found ?? 0}</td>
                    <td>
                      <span style={{ color: r.errors > 0 ? '#ef4444' : '#10b981', fontWeight: 600 }}>
                        {r.errors ?? 0}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          {selected ? (
            <>
              <h2>Run #{selected.id} — {new Date(selected.started_at).toLocaleString()}</h2>
              <div style={{ display: 'flex', gap: 20, fontSize: 13, color: '#6b7280', marginBottom: 8 }}>
                <span>Properties checked: <strong>{selected.properties_checked}</strong></span>
                <span>New bills: <strong style={{ color: '#10b981' }}>{selected.bills_found}</strong></span>
                <span>Errors: <strong style={{ color: selected.errors > 0 ? '#ef4444' : '#6b7280' }}>{selected.errors}</strong></span>
                <span>Duration: <strong>{duration(selected.started_at, selected.finished_at)}</strong></span>
              </div>
              <div className="log-box">{selected.log || '(no log)'}</div>
            </>
          ) : (
            <div className="empty">Select a run to view the log.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function duration(start: string, end: string | null) {
  if (!end) return 'running…'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
