import * as XLSX from 'xlsx'

// Shared "download to Excel" used by the list pages. Each page passes the rows
// it is currently showing — already filtered by the search box and in the
// sorted order on screen — so the file matches what you were looking at.
export function downloadExcel(baseName: string, sheetName: string, rows: Record<string, any>[]) {
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{}])

  // Size each column to its widest value so the sheet is readable without
  // dragging borders. Capped so a long address doesn't blow the layout out.
  const headers = Object.keys(rows[0] || {})
  ws['!cols'] = headers.map(h => ({
    wch: Math.min(46, Math.max(h.length, ...rows.map(r => String(r[h] ?? '').length)) + 2),
  }))
  if (rows.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range(XLSX.utils.decode_range(ws['!ref']!)) }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31))
  XLSX.writeFile(wb, `${baseName}_${new Date().toISOString().slice(0, 10)}.xlsx`)
}

// Blank rather than an em dash or "null" — those are placeholders for the
// screen, and they'd only get in the way of sorting or filtering in Excel.
export const cell = (v: any) => (v == null || v === '' ? '' : v)

export const dateCell = (v: any) => (v ? String(v).slice(0, 10) : '')
