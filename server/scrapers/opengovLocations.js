'use strict';

// Auto-discovery of Baltimore City DHCD (OpenGov) location IDs.
//
// The portal's address search sits behind a bot challenge, but the public
// records API accepts an applicantUserID filter — so every record filed under
// our OpenGov account can be listed, and each record carries the locationID
// plus its street address. That gives an address -> locationID map with no
// login and no manual lookup.
//
// The API caps each response at 75 rows and ignores paging params, but it does
// honor `sort` and `recordTypeID`, so several differently-sorted slices are
// combined to cover the full record set.

const API = 'https://api-east.viewpointcloud.com/v2/baltimoremddhcd';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PropertyMonitor/1.0' };

const RECORD_TYPES = ['', '&recordTypeID=6432', '&recordTypeID=6435'];
const SORTS = [
  '', '&sort=recordID', '&sort=-recordID', '&sort=locationID', '&sort=-locationID',
  '&sort=streetName', '&sort=-streetName', '&sort=streetNo', '&sort=-streetNo',
  '&sort=dateCreated', '&sort=-dateCreated', '&sort=expirationDate', '&sort=-expirationDate',
];

// Street-suffix synonyms so "5004 CATALPHA ROAD" matches "5004 CATALPHA RD".
const SUFFIX_CANON = {
  STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', ROAD: 'RD', DRIVE: 'DR', LANE: 'LN',
  COURT: 'CT', PLACE: 'PL', BOULEVARD: 'BLVD', CIRCLE: 'CIR', TERRACE: 'TER',
  TRAIL: 'TRL', PARKWAY: 'PKWY', SQUARE: 'SQ', HIGHWAY: 'HWY', ALLEY: 'ALY',
  CRESCENT: 'CRES', PLAZA: 'PLZ', CROSSING: 'XING',
};

// Normalized "1114 GITTINGS AVE" style key used to join both sides.
function addressKey(streetNo, streetName) {
  if (!streetNo || !streetName) return null;
  const num = String(streetNo).toUpperCase().replace(/[^0-9A-Z/]/g, '');
  const words = String(streetName).toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')       // O'DONNELL -> ODONNELL
    .replace(/\s+/g, ' ').trim()
    .split(' ')
    .map(w => SUFFIX_CANON[w] || w);
  if (!words.length) return null;
  return `${num} ${words.join(' ')}`;
}

// Split a stored property address ("1114 GITTINGS AVE, BALTIMORE, MD, 21239").
function keyFromAddress(address) {
  const street = String(address || '').split(',')[0].trim().toUpperCase();
  const m = street.match(/^([0-9]+(?:\s+1\/2)?[A-Z]?)\s+(.+)$/);
  if (!m) return null;
  return addressKey(m[1], m[2]);
}

async function fetchSlice(qs) {
  const res = await fetch(`${API}/records?${qs}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`OpenGov API HTTP ${res.status}`);
  const json = await res.json();
  return json.data || [];
}

// Returns [{ locationID, streetNo, streetName, unit, key }]
async function harvestOpenGovLocations(applicantUserId) {
  // Accept several accounts (comma separated) — properties are sometimes filed
  // under a second OpenGov login or a manager's account.
  const userIds = String(applicantUserId || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!userIds.length) throw new Error('No OpenGov applicant user ID configured');

  const byLocation = new Map();
  let sliceErrors = 0;

  for (const userId of userIds)
  for (const type of RECORD_TYPES) {
    for (const sort of SORTS) {
      const qs = `applicantUserID=${encodeURIComponent(userId)}${type}${sort}`;
      let rows;
      try {
        rows = await fetchSlice(qs);
      } catch (err) {
        sliceErrors++;
        continue;
      }
      for (const row of rows) {
        const a = row.attributes || {};
        if (!a.locationID || byLocation.has(a.locationID)) continue;
        byLocation.set(a.locationID, {
          locationID: a.locationID,
          streetNo: a.streetNo,
          streetName: a.streetName,
          unit: a.unit || null,
          key: addressKey(a.streetNo, a.streetName),
        });
      }
    }
  }

  if (byLocation.size === 0 && sliceErrors > 0) {
    throw new Error('Could not reach the OpenGov records API');
  }
  return [...byLocation.values()];
}

// ── Public address lookup (no account needed) ───────────────────────────────
// The portal's own address search is behind a bot challenge, but the locations
// endpoint it queries is public — it just demands an exact ZIP+4, which we
// don't store. The city parcel layer has ZIP+4 for every address in the city,
// so: address -> parcel (ZIP+4) -> locationID.

const PARCELS = 'https://geodata.baltimorecity.gov/egis/rest/services/CityView/Realproperty_OB/MapServer/0/query';

const sqlQuote = s => String(s).replace(/'/g, "''");

// "2639 BOSTON ST APT 213" / "... #213" / "... UNIT 213" -> "213"
function unitOf(address) {
  const street = String(address || '').split(',')[0].toUpperCase();
  const m = street.match(/(?:\b(?:APT|UNIT|STE|SUITE|FL|FLOOR)\s*|#\s*)([A-Z0-9][A-Z0-9-]*)\s*$/);
  return m ? m[1] : null;
}

// "1212 N BENTALOU ST, BALTIMORE, MD, 21216" -> number/direction/name parts
function splitStreet(address) {
  const street = String(address || '').split(',')[0].trim().toUpperCase()
    .replace(/[.#]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = street.match(/^(\d+)(\s+1\/2)?\s+(.+)$/);
  if (!m) return null;
  // Drop any unit designator — the parcel layer is keyed by building.
  const rest = m[3].replace(/\s*(?:\b(?:APT|UNIT|STE|SUITE|FL|FLOOR)\b\s*|#\s*)[A-Z0-9][A-Z0-9-]*\s*$/, '').trim();
  return { number: m[1], fraction: m[2] ? '1/2' : '', rest: rest || m[3] };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Look the address up in the city parcel layer to get its ZIP+4 and the
// street name exactly as the city spells it.
async function lookupParcel(address) {
  const parts = splitStreet(address);
  if (!parts) return null;

  // Drop a leading direction and the trailing street type; the parcel layer
  // keeps those in their own columns.
  const words = parts.rest.split(' ');
  const dir = ['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW'].includes(words[0]) ? words.shift() : '';
  const SUFFIX_WORDS = new Set(Object.keys(SUFFIX_CANON).concat(Object.values(SUFFIX_CANON)));
  if (words.length > 1 && SUFFIX_WORDS.has(words[words.length - 1])) words.pop();
  const wanted = words.join(' ').replace(/[^A-Z0-9]/g, '');   // O'DONNELL -> ODONNELL

  // Match on just the first letter and confirm in code: the parcel layer keeps
  // punctuation ("O'DONNELL") that our stored addresses may drop, so a literal
  // prefix match would miss those.
  const where = `BLDG_NO='${sqlQuote(parts.number)}' AND UPPER(ST_NAME) LIKE '${sqlQuote(wanted[0] || '')}%'`
    + (dir ? ` AND UPPER(STDIRPRE) LIKE '${dir}%'` : '');
  const url = `${PARCELS}?where=${encodeURIComponent(where)}&outFields=FULLADDR,ZIP_CODE,EXTD_ZIP,ST_NAME,ST_TYPE,STDIRPRE,BLDG_NO,UNIT_NUM&f=json&resultRecordCount=100`;

  let data;
  try { data = await fetchJson(url); } catch { return null; }
  const rows = (data.features || []).map(f => f.attributes);
  if (!rows.length) return null;

  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const onStreet = rows.filter(r => norm(r.ST_NAME) === wanted);
  const candidates = onStreet.length ? onStreet : rows;

  // Units in one building can sit in different ZIP+4 blocks, and the locations
  // endpoint needs the exact one — so match the parcel for this specific unit.
  const unit = unitOf(address);
  const row = (unit && candidates.find(r => norm(r.UNIT_NUM) === norm(unit))) || candidates[0];
  const zip = String(row.ZIP_CODE || '').trim();
  const ext = String(row.EXTD_ZIP || '').trim();
  if (!zip || !ext) return null;

  const streetName = [
    String(row.STDIRPRE || '').trim(),
    String(row.ST_NAME || '').trim(),
    String(row.ST_TYPE || '').trim(),
  ].filter(Boolean).join(' ');

  return {
    streetNo: String(row.BLDG_NO || parts.number).trim(),
    streetName,
    postalCode: `${zip}-${ext}`,
  };
}

// Resolve a street address to its DHCD location ID, with no login and no
// dependence on who filed the records.
async function resolveLocationIdByAddress(address) {
  const parcel = await lookupParcel(address);
  if (!parcel) return null;

  const qs = new URLSearchParams({
    streetNo: parcel.streetNo,
    streetName: parcel.streetName,
    city: 'Baltimore',
    state: 'MD',
    country: 'US',
    postalCode: parcel.postalCode,
    mode: 'unitLocations',
  });

  let data;
  try { data = await fetchJson(`${API}/locations?${qs}`); } catch { return null; }
  const rows = (data.data || []).map(r => r.attributes);
  if (!rows.length) return null;

  // When we manage a single unit, licensing is per unit — so an address that
  // names a unit must resolve to that unit and never to the whole building.
  const wantedUnit = unitOf(address);
  const normUnit = u => String(u || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');

  if (wantedUnit) {
    const match = rows.find(r => r.unit && normUnit(r.unit) === normUnit(wantedUnit));
    if (!match) return null;   // don't fall back to the building
    return { locationID: match.locationID, fullAddress: match.fullAddress, unit: match.unit };
  }

  const building = rows.find(r => !r.unit);
  if (building) return { locationID: building.locationID, fullAddress: building.fullAddress, unit: null };

  // Only units exist and the address doesn't say which one — guessing would
  // report someone else's license, so report the ambiguity instead.
  return { needsUnit: true, units: rows.filter(r => r.unit).map(r => r.unit) };
}

// DHCD knows the year built for every location it holds, including condo
// units that the parcel layers miss.
async function lookupYearBuiltByAddress(address, knownLocationId) {
  let id = knownLocationId || null;
  if (!id) {
    const hit = await resolveLocationIdByAddress(address);
    if (!hit || !hit.locationID) return null;
    id = hit.locationID;
  }
  try {
    const data = await fetchJson(`${API}/locations?filter%5Bid%5D=${encodeURIComponent(id)}`);
    const a = (data.data || [])[0] && data.data[0].attributes;
    const year = a && Number(a.yearBuilt);
    return year > 1700 ? { year_built: year, locationID: id } : null;
  } catch { return null; }
}

module.exports = {
  harvestOpenGovLocations,
  addressKey,
  keyFromAddress,
  resolveLocationIdByAddress,
  lookupYearBuiltByAddress,
};
