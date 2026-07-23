import { useEffect, useState, useMemo } from 'react'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx'
import { useLocalState } from '../useLocalState'

const STATUSES = ['', 'new', 'reviewed', 'entered', 'paid']

type SortCol = 'property_name' | 'municipality' | 'bill_date' | 'due_date' | 'amount_due' | 'last_pay_date' | 'last_pay_amount' | 'status' | 'period_start' | 'period_end'

export default function Bills() {
  const [bills, setBills] = useState<any[]>([])
  const [filterStatus, setFilterStatus] = useLocalState('bills.filterStatus', '')
  const [filterProp, setFilterProp] = useLocalState('bills.filterProp', '')
  const [properties, setProperties] = useState<any[]>([])
  const [sortCol, setSortCol] = useLocalState<SortCol>('bills.sortCol', 'bill_date')
  const [sortDir, setSortDir] = useLocalState<'asc' | 'desc'>('bills.sortDir', 'desc')
  const [search, setSearch] = useLocalState('bills.search', '')

  useEffect(() => {
    fetch('/api/properties').then(r => r.json()).then(setProperties)
  }, [])

  useEffect(() => { load() }, [filterStatus, filterProp])

  async function load() {
    const params = new URLSearchParams({ limit: '500' })
    if (filterStatus) params.set('status', filterStatus)
    if (filterProp) params.set('property_id', filterProp)
    const data = await fetch(`/api/bills?${params}`).then(r => r.json())
    setBills(data)
  }

  const [emailing, setEmailing] = useState<number | null>(null)

  async function emailBill(id: number) {
    setEmailing(id)
    try {
      const resp = await fetch(`/api/email/bill/${id}`, { method: 'POST' })
      if (!resp.ok) {
        const err = await resp.json()
        alert(`Email failed: ${err.error}`)
      } else {
        load()
      }
    } catch {
      alert('Email request failed.')
    } finally {
      setEmailing(null)
    }
  }

  async function updateStatus(id: number, status: string) {
    await fetch(`/api/bills/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    })
    load()
  }

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const arrow = (col: SortCol) => sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''

  const muniLabel = (m: string) => ({ baltimore_city: 'Balt. City', baltimore_county: 'Balt. County', harford: 'Harford' }[m] || m)

  const q = search.toLowerCase()
  const sorted = useMemo(() => [...bills]
    .filter(b => !q || [b.property_name, b.bill_date, b.due_date, b.status, muniLabel(b.municipality)].some(v => v?.toLowerCase().includes(q)))
    .sort((a, b) => {
    const av = a[sortCol] ?? ''
    const bv = b[sortCol] ?? ''
    const cmp = typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv))
    return sortDir === 'asc' ? cmp : -cmp
  }), [bills, sortCol, sortDir, q])

  function exportPdf() {
    const doc = new jsPDF({ orientation: 'landscape' })
    doc.setFontSize(14)
    doc.text('Water Bills Export', 14, 15)
    doc.setFontSize(9)
    doc.text(`Generated ${new Date().toLocaleString()}  ·  ${sorted.length} bills`, 14, 21)

    autoTable(doc, {
      startY: 26,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [37, 99, 235] },
      head: [['Property', 'Municipality', 'Period Start', 'Period End', 'Bill Date', 'Due Date', 'Amount Due', 'Last Pay Date', 'Last Pay Amt', 'Status']],
      body: sorted.map(b => [
        b.property_name,
        muniLabel(b.municipality),
        b.period_start || '—',
        b.period_end || '—',
        b.bill_date || '—',
        b.due_date || '—',
        b.amount_due != null ? `$${Number(b.amount_due).toFixed(2)}` : '—',
        b.last_pay_date || '—',
        b.last_pay_amount != null ? `$${Math.abs(Number(b.last_pay_amount)).toFixed(2)}` : '—',
        b.status,
      ]),
    })

    const suffix = filterProp
      ? `_${properties.find(p => String(p.id) === filterProp)?.name?.replace(/\s+/g, '_') || filterProp}`
      : ''
    doc.save(`water-bills${suffix}_${new Date().toISOString().slice(0, 10)}.pdf`)
  }

  function exportExcel() {
    const suffix = filterProp
      ? `_${properties.find(p => String(p.id) === filterProp)?.name?.replace(/\s+/g, '_') || filterProp}`
      : ''
    const rows = sorted.map(b => ({
      Property: b.property_name,
      Municipality: muniLabel(b.municipality),
      'Period Start': b.period_start || '',
      'Period End': b.period_end || '',
      'Bill Date': b.bill_date || '',
      'Due Date': b.due_date || '',
      'Amount Due': b.amount_due != null ? Number(b.amount_due) : '',
      'Last Pay Date': b.last_pay_date || '',
      'Last Pay Amt': b.last_pay_amount != null ? Math.abs(Number(b.last_pay_amount)) : '',
      Status: b.status,
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Bills')
    XLSX.writeFile(wb, `water-bills${suffix}_${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  const muniClass = (m: string) => ({ baltimore_city: 'badge-city', baltimore_county: 'badge-county', harford: 'badge-harford' }[m] || '')

  const Th = ({ col, children }: { col: SortCol; children: React.ReactNode }) => (
    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort(col)}>
      {children}{arrow(col)}
    </th>
  )

  return (
    <div>
      <div className="toolbar">
        <h1>Bills</h1>
        <input className="filter" style={{ minWidth: 180 }} placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="filter" value={filterProp} onChange={e => setFilterProp(e.target.value)}>
          <option value="">All Properties</option>
          {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="filter" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          {STATUSES.map(s => <option key={s} value={s}>{s || 'All Statuses'}</option>)}
        </select>
        {sorted.length > 0 && (<>
          <button className="btn btn-ghost" onClick={exportPdf}>⬇ Export PDF</button>
          <button className="btn btn-ghost" onClick={exportExcel}>⬇ Export Excel</button>
        </>)}
      </div>

      <div className="card">
        {sorted.length === 0 ? (
          <div className="empty">No bills match the current filters.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <Th col="property_name">Property</Th>
                <Th col="municipality">Municipality</Th>
                <Th col="period_start">Period Start</Th>
                <Th col="period_end">Period End</Th>
                <Th col="bill_date">Bill Date</Th>
                <Th col="due_date">Due Date</Th>
                <Th col="amount_due">Amount Due</Th>
                <Th col="last_pay_date">Last Pay Date</Th>
                <Th col="last_pay_amount">Last Pay Amt</Th>
                <Th col="status">Status</Th>
                <th>PDF</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(b => (
                <tr key={b.id}>
                  <td><strong>{b.property_name}</strong></td>
                  <td><span className={`badge ${muniClass(b.municipality)}`}>{muniLabel(b.municipality)}</span></td>
                  <td>{b.period_start || '—'}</td>
                  <td>{b.period_end || '—'}</td>
                  <td>{b.bill_date || '—'}</td>
                  <td style={{ color: isOverdue(b.due_date) ? '#ef4444' : undefined, fontWeight: isOverdue(b.due_date) ? 600 : undefined }}>
                    {b.due_date || '—'}
                  </td>
                  <td><strong>{b.amount_due != null ? `$${Number(b.amount_due).toFixed(2)}` : '—'}</strong></td>
                  <td>{b.last_pay_date || '—'}</td>
                  <td style={{ color: '#059669' }}>
                    {b.last_pay_amount != null ? `$${Math.abs(Number(b.last_pay_amount)).toFixed(2)}` : '—'}
                  </td>
                  <td>
                    <select
                      className="filter"
                      style={{ padding: '2px 6px', fontSize: 12 }}
                      value={b.status}
                      onChange={e => updateStatus(b.id, e.target.value)}
                    >
                      {STATUSES.slice(1).map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {b.pdf_path
                      ? <a href={`/bills/${b.pdf_path.split(/[\\/]/).pop()}`} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm" style={{ marginRight: 4 }}>PDF</a>
                      : null}
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => emailBill(b.id)}
                      disabled={emailing === b.id}
                      title="Email bill summary"
                    >
                      {emailing === b.id ? '⟳' : '✉'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function isOverdue(due: string | null) {
  if (!due) return false
  return new Date(due) < new Date()
}
