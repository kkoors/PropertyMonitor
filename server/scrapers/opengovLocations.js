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

module.exports = { harvestOpenGovLocations, addressKey, keyFromAddress };
