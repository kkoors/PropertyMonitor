'use strict';

// Baltimore City rental registration & licensing.
// PRIMARY: the DHCD OpenGov (ViewPoint Cloud) public API — live system of record.
// FALLBACK: the city GIS layer (updated daily from OpenGov, can lag).
const OPENGOV_API = 'https://api-east.viewpointcloud.com/v2/baltimoremddhcd';
const PORTAL_URL = 'https://baltimoremddhcd.portal.opengov.com';
const GIS_BASE = 'https://geodata.baltimorecity.gov/egis/rest/services/Housing/OpenGov_RegAndLicense/MapServer/0/query';

const DIRECTIONS = new Set(['N', 'S', 'E', 'W', 'NORTH', 'SOUTH', 'EAST', 'WEST', 'NE', 'NW', 'SE', 'SW']);
const SUFFIXES = new Set([
  'ST', 'STREET', 'AVE', 'AVENUE', 'AV', 'RD', 'ROAD', 'DR', 'DRIVE', 'LN', 'LANE',
  'CT', 'COURT', 'PL', 'PLACE', 'WAY', 'BLVD', 'BOULEVARD', 'CIR', 'CIRCLE',
  'TER', 'TERRACE', 'TRL', 'TRAIL', 'PKWY', 'PARKWAY', 'SQ', 'SQUARE',
  'HWY', 'HIGHWAY', 'ALY', 'ALLEY', 'GARTH', 'MEWS', 'RUN', 'WALK', 'LOOP', 'PIKE', 'BEND', 'CRES', 'CRESCENT', 'PLZ', 'PLAZA', 'PATH', 'PASS', 'XING', 'CROSSING',
]);

function parseAddress(address) {
  const street = address.split(',')[0].trim().toUpperCase().replace(/[.#]/g, ' ').replace(/\s+/g, ' ').trim();
  const match = street.match(/^(\d+)[A-Z]?\s+(.+)$/);
  if (!match) return null;
  let parts = match[2].split(' ');

  const aptIdx = parts.findIndex(t => ['APT', 'UNIT', 'STE', 'SUITE', 'FL', 'FLOOR', 'REAR'].includes(t));
  if (aptIdx >= 0) parts = parts.slice(0, aptIdx);

  let dir = '';
  if (parts.length > 1 && DIRECTIONS.has(parts[0])) dir = parts.shift();

  let suffix = '';
  if (parts.length > 1 && SUFFIXES.has(parts[parts.length - 1])) suffix = parts.pop();

  const name = parts.join(' ');
  if (!name) return null;
  return { number: match[1], name, dir, suffix };
}

function isoDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function toEntry(rec) {
  if (!rec) return null;
  const a = rec.attributes;
  const expDate = isoDate(a.expirationDate);
  return {
    license_number: a.recordNumber != null ? String(a.recordNumber) : null,
    status: expDate && new Date(expDate) < new Date() ? 'expired' : 'active',
    issue_date: isoDate(a.dateSubmitted || a.dateCreated),
    exp_date: expDate,
    owner_name: a.ownerName || null,
    notes: `${PORTAL_URL}/records/${a.recordID}`,
  };
}

// ── OpenGov API (primary; needs the property's OpenGov location ID) ─────────
async function lookupOpenGov(locationId) {
  const url = `${OPENGOV_API}/records?locationID=${encodeURIComponent(locationId)}`;
  // API rejects requests with no User-Agent header
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PropertyMonitor/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OpenGov API HTTP ${res.status}`);
  const data = await res.json();

  const rows = data.data || [];
  console.log(`[balt-city] OpenGov locationID=${locationId}: ${rows.length} records`);
  if (rows.length === 0) return null;

  // Registration = "Property Registration…" records (annual, expire 12/31).
  // License = "…Rental License…" records that are NOT registration types.
  const regRows = rows.filter(r => /property registration/i.test(r.attributes.recordTypeName || ''));
  const licRows = rows.filter(r => {
    const n = r.attributes.recordTypeName || '';
    return /rental licen[cs]e/i.test(n) && !/property registration/i.test(n);
  });

  const latest = list => list
    .filter(r => r.attributes.expirationDate)
    .sort((a, b) => new Date(b.attributes.expirationDate) - new Date(a.attributes.expirationDate))[0];

  return {
    registration: toEntry(latest(regRows)),
    license: toEntry(latest(licRows)),
  };
}

// ── GIS layer (fallback) ────────────────────────────────────────────────────
async function lookupGis(parsed) {
  const dirPart = parsed.dir ? `${parsed.dir[0]} ` : '';
  const prefix = `${parsed.number} ${dirPart}${parsed.name}`.replace(/'/g, "''");
  const params = new URLSearchParams({
    where: `UPPER(Address) LIKE '${prefix}%'`,
    outFields: '*',
    f: 'json',
    resultRecordCount: '10',
  });

  const res = await fetch(`${GIS_BASE}?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error) return null;

  const features = (data.features || []).map(f => f.attributes);
  console.log(`[balt-city] GIS fallback: ${features.length} rows for '${prefix}%'`);
  if (features.length === 0) return null;

  const msToDate = ms => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : null);
  const gisEntry = f => {
    if (!f) return null;
    const expDate = msToDate(f.LicenseExpirationDate);
    return {
      license_number: f.RecordNUMBER != null ? String(f.RecordNUMBER) : null,
      status: expDate && new Date(expDate) < new Date() ? 'expired' : 'active',
      issue_date: msToDate(f.LicenseIssuedDate),
      exp_date: expDate,
    };
  };
  const latestOf = list => list.sort((a, b) => (b.LicenseExpirationDate || 0) - (a.LicenseExpirationDate || 0))[0];

  return {
    license: gisEntry(latestOf(features.filter(f => f.LicenceOrRegistration === 'Yes'))),
    registration: gisEntry(latestOf(features.filter(f => f.LicenceOrRegistration === 'No'))),
  };
}

async function scrapeRentalLicenseBaltimoreCity(property) {
  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  // Location ID may be stored as a bare number or a pasted portal URL
  const locMatch = (property.opengov_location_id || '').match(/(\d{3,})/);
  const locationId = locMatch ? locMatch[1] : null;

  let result = null;
  if (locationId) {
    try {
      result = await lookupOpenGov(locationId);
    } catch (err) {
      console.log(`[balt-city] OpenGov API failed (${err.message}) — falling back to GIS layer`);
    }
  }
  if (!result) {
    try { result = await lookupGis(parsed); } catch { /* handled below */ }
  }
  if (!result) {
    return { license_number: null, status: 'not_found', exp_date: null };
  }

  const { license, registration } = result;
  // Back-compat top-level fields = license (falls back to not_licensed if only registered)
  return {
    ...(license || { license_number: registration?.license_number || null, status: 'not_licensed', issue_date: registration?.issue_date || null, exp_date: null }),
    license,
    registration,
  };
}

module.exports = { scrapeRentalLicenseBaltimoreCity };
