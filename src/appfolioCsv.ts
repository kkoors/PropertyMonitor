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

// Long spellings folded to the abbreviation we store, so "Hazel Lane" matches
// "HAZEL LN" and "North Bentalou Street" matches "N BENTALOU ST". The type is
// normalised rather than dropped — Oak Rd and Oak St stay different streets.
const WORD_FORMS: [RegExp, string][] = [
  [/\bAVENUE\b/g, 'AVE'], [/\bBOULEVARD\b/g, 'BLVD'], [/\bCIRCLE\b/g, 'CIR'],
  [/\bCOURT\b/g, 'CT'], [/\bDRIVE\b/g, 'DR'], [/\bHIGHWAY\b/g, 'HWY'],
  [/\bLANE\b/g, 'LN'], [/\bPARKWAY\b/g, 'PKWY'], [/\bPLACE\b/g, 'PL'],
  [/\bROAD\b/g, 'RD'], [/\bSQUARE\b/g, 'SQ'], [/\bSTREET\b/g, 'ST'],
  [/\bTERRACE\b/g, 'TER'], [/\bTRAIL\b/g, 'TRL'],
  [/\bNORTH\b/g, 'N'], [/\bSOUTH\b/g, 'S'], [/\bEAST\b/g, 'E'], [/\bWEST\b/g, 'W'],
  [/\bSAINT\b/g, 'ST'], [/\bMOUNT\b/g, 'MT'],
]

// A deliberately loose key for spellings we've corrected here but AppFolio
// still has wrong: apostrophes, hyphens and missing spaces all disappear, so
// "2831 ODONNELL" matches "2831 O'Donnell" and "1010 WSHORE" matches
// "1010 West Shore".
export function looseStreetKey(address: string): string {
  let s = streetKey(address)
  for (const [re, to] of WORD_FORMS) s = s.replace(re, to)
  return s.replace(/[^A-Z0-9]/g, '')
}

// Last resort: the same key with any unit designator removed, for exports that
// carry the unit in the street line when we hold the building as one record.
export function unitlessStreetKey(address: string): string {
  const s = streetKey(address)
    .replace(new RegExp(`\\b(${UNIT_WORDS})\\b.*$`), '')
    .replace(/#.*$/, '')
  return looseStreetKey(s)
}

// Tab-separated exports are common — Excel produces them, and a tab file has
// no trouble with the commas inside an address. Whichever character appears
// more on the first substantial line is the delimiter.
function sniffDelimiter(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const tabs = (line.match(/\t/g) || []).length
    const commas = (line.match(/,/g) || []).length
    if (tabs || commas) return tabs >= commas ? '\t' : ','
  }
  return ','
}

// Minimal CSV parser with quoted-field support
export function parseCsv(text: string, delimiter?: string): string[][] {
  const delim = delimiter || sniffDelimiter(text)
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
    else if (c === delim) { row.push(field); field = '' }
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

// Street types, longest spellings first so "Drive" wins over "Dr".
const STREET_TYPES = [
  'AVENUE', 'AVE', 'BOULEVARD', 'BLVD', 'CIRCLE', 'CIR', 'COURT', 'CT', 'DRIVE', 'DR',
  'HIGHWAY', 'HWY', 'LANE', 'LN', 'LOOP', 'PARKWAY', 'PKWY', 'PLACE', 'PL', 'ROAD', 'RD',
  'SQUARE', 'SQ', 'STREET', 'ST', 'TERRACE', 'TER', 'TRAIL', 'TRL', 'WAY',
]
const UNIT_WORDS = 'APT|APARTMENT|UNIT|STE|SUITE|FL|FLOOR|BSMT|BASEMENT|RM|ROOM'

// Splits "10 Valley Ridge Loop Cockeysville" into street and city. The export
// runs the two together with no comma, so the street type is the only marker
// of where the street ends — everything after the last one is the city. A unit
// that follows the street type ("… Drive Unit 120-H Bel Air") stays with the
// street, or it would be read as part of the city.
function splitStreetAndCity(s: string): { street: string, city: string } {
  const words = s.trim().split(/\s+/)
  let cut = -1
  for (let i = words.length - 1; i >= 1; i--) {
    const w = words[i].toUpperCase().replace(/[^A-Z]/g, '')
    if (STREET_TYPES.includes(w)) { cut = i; break }
  }
  if (cut < 0 || cut === words.length - 1) return { street: s.trim(), city: '' }

  let end = cut + 1
  const unitRe = new RegExp(`^(#|(${UNIT_WORDS})$)`, 'i')
  if (unitRe.test(words[end].replace(/[.,]/g, ''))) {
    // "Unit 120-H" — take the keyword and the designator that follows it.
    end += words[end].startsWith('#') ? 1 : 2
  }
  return { street: words.slice(0, end).join(' '), city: words.slice(end).join(' ') }
}

// Pulls street/city/state/ZIP out of a single address line, however it's
// punctuated: "123 Main St, Baltimore, MD 21201", "123 Main St Baltimore, MD
// 21201", or a row whose commas have already split it into cells.
export function parseAddressLine(line: string): { street: string, city: string, state: string, zip: string } {
  const parts = String(line || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!parts.length) return { street: '', city: '', state: '', zip: '' }

  let state = '', zip = ''
  const tail = parts.slice(1).join(' ')
  const m = tail.match(/\b([A-Za-z]{2})\b[\s,]*(\d{5})(?:-\d{4})?\s*$/)
  let rest: string
  if (m) {
    state = m[1].toUpperCase()
    zip = m[2]
    rest = tail.slice(0, m.index).trim()
  } else {
    const z = tail.match(/\b(\d{5})(?:-\d{4})?\b/)
    zip = z ? z[1] : ''
    rest = (z ? tail.slice(0, z.index) : tail).replace(/\b[A-Za-z]{2}\b\s*$/, '').trim()
  }

  // Anything left between the street and the state is the city. If there was
  // none, the city is still buried in the first segment.
  if (rest) return { street: parts[0], city: rest, state, zip }
  const split = splitStreetAndCity(parts[0])
  return { street: split.street, city: split.city, state, zip }
}

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
    const { street, city, state, zip } = parseAddressLine(cells.join(', '))
    if (!street) continue

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
  // "Property Address" and "Service Address" are as common as a bare
  // "Address", so the column is matched anywhere in the heading.
  const addrCol  = findCol(headers, /^address\s*1?$/i, /address/i, /street/i)
  const cityCol  = findCol(headers, /^city$/i)
  const stateCol = findCol(headers, /^state$/i, /^st$/i)
  const zipCol   = findCol(headers, /zip/i, /postal/i)
  const ownerAddrCol = findCol(headers, /owner.*address/i, /mailing.*address/i)
  // "Owner(s)", "Owner Name", "Owners" — anything mentioning an owner that
  // isn't the owner's address column.
  const ownerCol = headers.findIndex((h, i) => i !== ownerAddrCol && /owner/i.test(h))

  // A header we can't place is worse than no header — fall back to reading the
  // file as a plain address list rather than importing nothing.
  if (addrCol < 0) {
    const data = raw.filter(r => looksLikeAddress(r))
    if (data.length) return mapHeaderless(data)
    return { rows: [], warnings: [...warnings, 'Could not find an address column — check the export'] }
  }

  const rows: ImportRow[] = raw.slice(headerIdx + 1).map(r => {
    // An unquoted "10 Valley Ridge Loop Cockeysville, MD 21030" has already
    // been split at its own comma, so the row carries more cells than the
    // header has columns and every later column is shifted along. Work out how
    // many of the surplus cells the address actually took: keep absorbing until
    // a ZIP turns up, then stop — the rest belong to whatever follows, since a
    // name like "Emerge Properties, LLC" splits the same way.
    const extra = Math.max(0, r.length - headers.length)
    const lastCol = headers.length - 1
    let taken = 0
    if (addrCol === lastCol) {
      taken = extra   // nothing follows the address, so it's all address
    } else {
      while (taken < extra && !/\d{5}/.test(r.slice(addrCol, addrCol + taken + 1).join(' '))) taken++
    }

    // The final column mops up anything still spare, so a comma inside the last
    // value doesn't truncate it.
    const at = (col: number): string => {
      if (col < 0) return ''
      const from = col > addrCol ? col + taken : col
      const cells = col === lastCol ? r.slice(from) : [r[from]]
      return cells.map(c => (c || '').trim()).filter(Boolean).join(', ')
    }

    const addrCells = r.slice(addrCol, addrCol + taken + 1).map(c => (c || '').trim()).filter(Boolean)
    let city = at(cityCol)
    let state = at(stateCol)
    let zip = at(zipCol)

    // With no city column the whole address sits in that one field, in
    // whatever shape the export used.
    let street = addrCells[0] || ''
    if (!city || !zip) {
      const parsed = parseAddressLine(addrCells.join(', '))
      street = parsed.street || street
      city = city || parsed.city
      state = state || parsed.state
      zip = zip || parsed.zip
    }

    return {
      name: (nameCol >= 0 ? at(nameCol) : '') || street,
      // Same shape as the properties we already hold — "STREET, CITY, MD, ZIP".
      // The parcel and licence lookups parse this, so a different layout here
      // would quietly fail to match.
      address: [street, city, state || (city ? 'MD' : ''), zip].filter(Boolean).join(', '),
      municipality: guessMunicipality(city, zip),
      // AppFolio writes double spaces into some names ("Paul  Eiseman").
      owner_name: at(ownerCol).replace(/\s+/g, ' '),
      owner_address: at(ownerAddrCol).replace(/\s+/g, ' '),
    }
  }).filter(r => r.address)

  return { rows, warnings }
}
