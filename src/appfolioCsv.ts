// Parse an AppFolio property report CSV and map its columns to our fields.

export interface ImportRow {
  name: string
  address: string
  municipality: string
  owner_name: string
  owner_address: string
  matched?: boolean
  skip?: boolean
}

// Minimal CSV parser with quoted-field support
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f.trim() !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some(f => f.trim() !== '')) rows.push(row)
  return rows
}

function findCol(headers: string[], ...patterns: RegExp[]): number {
  for (const p of patterns) {
    const i = headers.findIndex(h => p.test(h))
    if (i >= 0) return i
  }
  return -1
}

// Rough municipality guess from city/zip; user can override in the preview
export function guessMunicipality(city: string, zip: string): string {
  const c = (city || '').toUpperCase()
  const z = (zip || '').trim()
  const HARFORD_ZIPS = ['21001', '21009', '21010', '21014', '21015', '21017', '21028', '21034', '21040', '21047', '21050', '21078', '21084', '21085', '21132', '21154', '21161']
  if (HARFORD_ZIPS.includes(z)) return 'harford'
  if (/BEL AIR|ABERDEEN|EDGEWOOD|JOPPA|HAVRE DE GRACE|FALLSTON|FOREST HILL|ABINGDON/.test(c)) return 'harford'
  if (z.startsWith('212')) return 'baltimore_city'
  if (c === 'BALTIMORE' && z.startsWith('212')) return 'baltimore_city'
  return 'baltimore_county'
}

export function mapAppfolioCsv(text: string): { rows: ImportRow[]; warnings: string[] } {
  const raw = parseCsv(text)
  const warnings: string[] = []
  if (raw.length < 2) return { rows: [], warnings: ['CSV has no data rows'] }

  // AppFolio reports sometimes have a title row before the header — find the header row
  let headerIdx = raw.findIndex(r => r.some(c => /address/i.test(c)))
  if (headerIdx < 0) { headerIdx = 0; warnings.push('No "Address" column found — using first row as header') }
  const headers = raw[headerIdx].map(h => h.trim())

  const nameCol  = findCol(headers, /^property\s*name$/i, /^property$/i, /^name$/i)
  const addrCol  = findCol(headers, /^address\s*1?$/i, /street/i, /^address/i)
  const cityCol  = findCol(headers, /^city$/i)
  const zipCol   = findCol(headers, /zip/i, /postal/i)
  const ownerCol = findCol(headers, /^owner\s*name?s?$/i, /^owners?$/i)
  const ownerAddrCol = findCol(headers, /owner.*address/i)

  if (addrCol < 0) warnings.push('Could not find an address column — check the export')

  const rows: ImportRow[] = raw.slice(headerIdx + 1).map(r => {
    const address = (r[addrCol] || '').trim()
    const city = cityCol >= 0 ? (r[cityCol] || '').trim() : ''
    const zip = zipCol >= 0 ? (r[zipCol] || '').trim() : ''
    return {
      name: (nameCol >= 0 ? r[nameCol] : '')?.trim() || address.split(',')[0],
      address: city ? `${address}, ${city}${zip ? ' ' + zip : ''}` : address,
      municipality: guessMunicipality(city, zip),
      owner_name: ownerCol >= 0 ? (r[ownerCol] || '').trim() : '',
      owner_address: ownerAddrCol >= 0 ? (r[ownerAddrCol] || '').trim() : '',
    }
  }).filter(r => r.address)

  return { rows, warnings }
}
