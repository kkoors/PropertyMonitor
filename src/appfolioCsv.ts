// Parse an AppFolio property report CSV and map its columns to our fields.

export interface ImportRow {
  name: string
  address: string
  municipality: string
  owner_name: string
  owner_address: string
  matched?: boolean
  /** How the row was matched: exactly, or by loose spelling. */
  matchedVia?: 'exact' | 'close'
  /** The address we already hold, shown when the two spellings differ. */
  matchedAddress?: string
  skip?: boolean
}

// Street portion only, punctuation flattened to single spaces.
export function streetKey(address: string): string {
  return (address || '').split(',')[0].toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

// A deliberately loose key for spellings we've corrected here but AppFolio
// still has wrong: apostrophes, hyphens and missing spaces all disappear, so
// "2831 ODONNELL" matches "2831 O'Donnell" and "1010 WESTSHORE" matches
// "1010 West Shore". Street types are left alone — Oak Rd and Oak St are
// different streets, and collapsing them would merge real properties.
export function looseStreetKey(address: string): string {
  return streetKey(address)
    .replace(/\bSAINT\b/g, 'ST')
    .replace(/\bMOUNT\b/g, 'MT')
    .replace(/[^A-Z0-9]/g, '')
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

// A row that starts with a street number is data, not a header.
const looksLikeAddress = (cells: string[]) => /^\s*\d+[-\s]/.test(cells[0] || '')

// Some exports are just a bare list of addresses with no header row at all,
// either one per line or split across street/city/state/zip columns. Nothing
// then names the columns, so they're identified by shape: a two-letter state,
// a five-digit ZIP, and whatever sits between them is the city.
function mapHeaderless(raw: string[][]): { rows: ImportRow[]; warnings: string[] } {
  const rows: ImportRow[] = []
  for (const r of raw) {
    const cells = r.map(c => (c || '').trim()).filter(Boolean)
    if (!cells.length) continue

    // An unquoted "123 Main St, Baltimore, MD 21201" arrives already split on
    // its commas, so real columns and one run-together field look the same by
    // the time we see them. Rejoining and parsing the whole line handles both.
    const parts = cells.join(', ').split(',').map(s => s.trim()).filter(Boolean)
    const street = parts[0]
    if (!street) continue

    const tail = parts.slice(1).join(' ')
    let city = '', state = '', zip = ''
    const m = tail.match(/\b([A-Za-z]{2})\b[\s,]*(\d{5})(?:-\d{4})?\s*$/)
    if (m) {
      state = m[1].toUpperCase()
      zip = m[2]
      city = tail.slice(0, m.index).trim()
    } else {
      const z = tail.match(/\b(\d{5})(?:-\d{4})?\b/)
      zip = z ? z[1] : ''
      city = (z ? tail.slice(0, z.index) : tail).replace(/\b[A-Za-z]{2}\b\s*$/, '').trim()
    }

    rows.push({
      name: street,
      address: [street, city, state || (city ? 'MD' : ''), zip].filter(Boolean).join(', '),
      municipality: guessMunicipality(city, zip),
      owner_name: '',
      owner_address: '',
    })
  }
  return {
    rows,
    warnings: rows.length ? ['No header row — read every line as an address. Check the municipalities before importing.'] : ['Nothing in this file looks like an address'],
  }
}

export function mapAppfolioCsv(text: string): { rows: ImportRow[]; warnings: string[] } {
  const raw = parseCsv(text)
  const warnings: string[] = []
  if (!raw.length) return { rows: [], warnings: ['CSV is empty'] }

  // AppFolio reports sometimes have a title row before the header — find the header row
  let headerIdx = raw.findIndex(r => r.some(c => /address|street/i.test(c)) && !looksLikeAddress(r))

  // No header at all: the export is just a list of addresses.
  if (headerIdx < 0) {
    const data = raw.filter(r => looksLikeAddress(r))
    if (data.length) return mapHeaderless(data)
    headerIdx = 0
    warnings.push('No "Address" column found — using first row as header')
  }
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
