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

const HARFORD_ZIPS = new Set([
  '21001', '21009', '21010', '21013', '21014', '21015', '21017', '21028', '21034',
  '21040', '21047', '21050', '21078', '21084', '21085', '21130', '21132', '21154', '21161',
])

// Baltimore City proper. Everything else in the 212xx range is county — Dundalk
// (21222), Essex (21221), Towson (21204), Parkville (21234) and so on all mail
// as "Baltimore" but are county addresses, and they license through the county.
const CITY_ZIPS = new Set([
  '21201', '21202', '21205', '21206', '21209', '21210', '21211', '21212', '21213',
  '21214', '21215', '21216', '21217', '21218', '21223', '21224', '21225', '21226',
  '21229', '21230', '21231', '21239', '21251', '21287',
])

// First guess only — the preview lets you override each row, and the Verify
// button replaces these with the Census geocoder's answer.
export function guessMunicipality(city: string, zip: string): string {
  const c = (city || '').toUpperCase()
  const z = (zip || '').trim().slice(0, 5)
  if (HARFORD_ZIPS.has(z)) return 'harford'
  if (/BEL AIR|ABERDEEN|EDGEWOOD|JOPPA|HAVRE DE GRACE|FALLSTON|FOREST HILL|ABINGDON|CHURCHVILLE|DARLINGTON|STREET, MD/.test(c)) return 'harford'
  if (CITY_ZIPS.has(z)) return 'baltimore_city'
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
  const stateCol = findCol(headers, /^state$/i, /^st$/i)
  const zipCol   = findCol(headers, /zip/i, /postal/i)
  const ownerCol = findCol(headers, /^owner\s*name?s?$/i, /^owners?$/i)
  const ownerAddrCol = findCol(headers, /owner.*address/i)

  if (addrCol < 0) warnings.push('Could not find an address column — check the export')

  const rows: ImportRow[] = raw.slice(headerIdx + 1).map(r => {
    const address = (r[addrCol] || '').trim()
    const city = cityCol >= 0 ? (r[cityCol] || '').trim() : ''
    const state = stateCol >= 0 ? (r[stateCol] || '').trim() : ''
    const zip = zipCol >= 0 ? (r[zipCol] || '').trim() : ''
    return {
      name: (nameCol >= 0 ? r[nameCol] : '')?.trim() || address.split(',')[0],
      // Same shape as the properties we already hold — "STREET, CITY, MD, ZIP".
      // The parcel and licence lookups parse this, so a different layout here
      // would quietly fail to match.
      address: [address, city, state || (city ? 'MD' : ''), zip].filter(Boolean).join(', '),
      municipality: guessMunicipality(city, zip),
      owner_name: ownerCol >= 0 ? (r[ownerCol] || '').trim() : '',
      owner_address: ownerAddrCol >= 0 ? (r[ownerAddrCol] || '').trim() : '',
    }
  }).filter(r => r.address)

  return { rows, warnings }
}
