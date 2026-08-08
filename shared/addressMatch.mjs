// Deciding whether an incoming address is a property we already hold.
//
// Shared by the import preview in the browser and the import route on the
// server: if the two disagree, a row shown as "Update" comes in as a second
// copy. Keep this the only implementation.

/** Street portion only, punctuation flattened to single spaces. */
export function streetKey(address) {
  return String(address || '').split(',')[0].toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

// Long spellings folded to the abbreviation we store, so "Hazel Lane" matches
// "HAZEL LN" and "North Bentalou Street" matches "N BENTALOU ST". The type is
// normalised rather than dropped — Oak Rd and Oak St stay different streets.
const WORD_FORMS = [
  [/\bAVENUE\b/g, 'AVE'], [/\bBOULEVARD\b/g, 'BLVD'], [/\bCIRCLE\b/g, 'CIR'],
  [/\bCOURT\b/g, 'CT'], [/\bDRIVE\b/g, 'DR'], [/\bHIGHWAY\b/g, 'HWY'],
  [/\bLANE\b/g, 'LN'], [/\bPARKWAY\b/g, 'PKWY'], [/\bPLACE\b/g, 'PL'],
  [/\bROAD\b/g, 'RD'], [/\bSQUARE\b/g, 'SQ'], [/\bSTREET\b/g, 'ST'],
  [/\bTERRACE\b/g, 'TER'], [/\bTRAIL\b/g, 'TRL'],
  [/\bNORTH\b/g, 'N'], [/\bSOUTH\b/g, 'S'], [/\bEAST\b/g, 'E'], [/\bWEST\b/g, 'W'],
  [/\bSAINT\b/g, 'ST'], [/\bMOUNT\b/g, 'MT'],
]

const UNIT_WORDS = 'APT|APARTMENT|UNIT|STE|SUITE|FL|FLOOR|BSMT|BASEMENT|RM|ROOM'

/**
 * Spellings we've corrected here but AppFolio still has wrong: apostrophes,
 * hyphens and missing spaces all disappear, so "2831 ODONNELL" matches
 * "2831 O'Donnell" and "1010 WSHORE" matches "1010 West Shore".
 */
export function looseStreetKey(address) {
  let s = streetKey(address)
  for (const [re, to] of WORD_FORMS) s = s.replace(re, to)
  return s.replace(/[^A-Z0-9]/g, '')
}

/** The unit dropped, for exports that carry it in the street line when we hold
 *  the building as a single record. */
export function unitlessStreetKey(address) {
  const s = streetKey(address)
    .replace(new RegExp(`\\b(${UNIT_WORDS})\\b.*$`), '')
    .replace(/#.*$/, '')
  return looseStreetKey(s)
}

/** The direction dropped — AppFolio's "266 Susquehanna Avenue" against our
 *  "266 E SUSQUEHANNA AVE". Ambiguous on its own, so buildMatchIndex discards
 *  any such key that two different streets answer to. */
export function noDirectionKey(address) {
  let s = streetKey(address)
  for (const [re, to] of WORD_FORMS) s = s.replace(re, to)
  return s.replace(/\b(N|S|E|W|NE|NW|SE|SW)\b/g, ' ').replace(/[^A-Z0-9]/g, '')
}

const TIERS = [streetKey, looseStreetKey, unitlessStreetKey, noDirectionKey]

/**
 * Indexes the properties we hold, from the exact street down to the loosest
 * spelling, and looks an incoming address up through those tiers in order.
 */
export function buildMatchIndex(properties) {
  const maps = TIERS.map(() => new Map())
  for (const p of properties) {
    TIERS.forEach((fn, i) => {
      const k = fn(p.address || '')
      if (!k) return
      const m = maps[i]
      const seen = m.get(k)
      if (seen === undefined) { m.set(k, p); return }
      // A key that two genuinely different addresses answer to can't identify
      // either, so it's poisoned rather than resolved to whichever came first.
      // The same address held twice — 1427 S Hanover is listed per floor — is
      // not ambiguous: either row is the right one to update.
      if (seen && streetKey(seen.address || '') !== streetKey(p.address || '')) m.set(k, null)
    })
  }
  return {
    /** @returns {{property: any, exact: boolean}|null} */
    find(address) {
      for (let i = 0; i < TIERS.length; i++) {
        const hit = maps[i].get(TIERS[i](address || ''))
        if (hit) return { property: hit, exact: i === 0 }
      }
      return null
    },
  }
}
