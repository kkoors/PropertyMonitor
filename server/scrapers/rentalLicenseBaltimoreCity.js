'use strict';

// Baltimore City rental registration & licensing.
// PRIMARY: the DHCD OpenGov (ViewPoint Cloud) public API — live system of record.
// FALLBACK: the city GIS layer (updated daily from OpenGov, can lag).
const OPENGOV_API = 'https://api-east.viewpointcloud.com/v2/baltimoremddhcd';
const API_DOCS = `${OPENGOV_API}/docs`;
const PORTAL_URL = 'https://baltimoremddhcd.portal.opengov.com';
// The API rejects requests that send no User-Agent.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PropertyMonitor/1.0';
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

// ── Issued documents ────────────────────────────────────────────────────────
// The record's own expirationDate is not the license expiration: a combined
// "Property Registration and Rental Licensing" application expires on its own
// schedule while the license it issues runs 1-3 years from the inspection.
// The authoritative dates are printed on the issued documents, which the
// public `docs` endpoint exposes as HTML.

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function htmlToText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
}

// Printed dates arrive in loose forms: "August, 4 2027", "August,4 2027",
// "August 4, 2027".
function parsePrintedDate(month, day, year) {
  const mo = MONTHS[String(month).toLowerCase()];
  if (!mo || !day || !year) return null;
  return `${year}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function licenseExpFromText(text) {
  const m = text.match(/(?:RENTAL LICENSE EXPIRATION DATE|License Expiration Date)[:\s]*([A-Za-z]+)[,\s]+(\d{1,2})[,\s]+(\d{4})/i);
  return m ? parsePrintedDate(m[1], m[2], m[3]) : null;
}

function licenseIssueFromText(text) {
  const m = text.match(/License Issue Date[:\s]*([A-Za-z]+)[,\s]+(\d{1,2})[,\s]+(\d{4})/i);
  return m ? parsePrintedDate(m[1], m[2], m[3]) : null;
}

async function fetchDocs(recordId) {
  const res = await fetch(`${API_DOCS}?recordID=${recordId}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return [];
  const json = await res.json();
  return json.data || [];
}

// Walks every record's issued documents and returns the newest license and
// registration found.
async function entriesFromDocs(records) {
  let license = null, registration = null;

  const perRecord = await Promise.all(records.map(async rec => {
    try { return { rec, docs: await fetchDocs(rec.attributes.recordID) }; }
    catch { return { rec, docs: [] }; }
  }));

  for (const { rec, docs } of perRecord) {
    const a = rec.attributes;
    for (const doc of docs) {
      const d = doc.attributes || {};
      const title = d.docTitle || '';
      const text = htmlToText(d.html);
      const portal = `${PORTAL_URL}/records/${a.recordID}`;

      if (/rental license/i.test(title)) {
        // Prefer the date printed on the license; the doc's `expires` field
        // mirrors the record and is often a year late or missing entirely.
        const exp = licenseExpFromText(text) || isoDate(d.expires);
        if (!exp) continue;
        const num = (text.match(/License No[:\s]*([A-Za-z0-9-]+)/i) || [])[1]
          || (a.recordNumber != null ? String(a.recordNumber) : null);
        if (!license || exp > license.exp_date) {
          license = {
            license_number: num,
            exp_date: exp,
            issue_date: licenseIssueFromText(text) || isoDate(d.dateCreated),
            status: new Date(exp) < new Date() ? 'expired' : 'active',
            owner_name: a.ownerName || null,
            notes: portal,
          };
        }
      } else if (/registration/i.test(title)) {
        const exp = isoDate(d.expires);
        if (!exp) continue;
        if (!registration || exp > registration.exp_date) {
          registration = {
            license_number: a.recordNumber != null ? String(a.recordNumber) : null,
            exp_date: exp,
            issue_date: isoDate(d.dateCreated),
            status: new Date(exp) < new Date() ? 'expired' : 'active',
            owner_name: a.ownerName || null,
            notes: portal,
          };
        }
      }
    }
  }
  return { license, registration };
}

// ── OpenGov API (primary; needs the property's OpenGov location ID) ─────────
async function lookupOpenGov(locationId) {
  const url = `${OPENGOV_API}/records?locationID=${encodeURIComponent(locationId)}`;
  // API rejects requests with no User-Agent header
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OpenGov API HTTP ${res.status}`);
  const data = await res.json();

  const rows = data.data || [];
  console.log(`[balt-city] OpenGov locationID=${locationId}: ${rows.length} records`);
  if (rows.length === 0) return null;

  // Preferred source: the issued license / registration documents.
  const fromDocs = await entriesFromDocs(rows);
  if (fromDocs.license || fromDocs.registration) {
    console.log(`[balt-city]   docs: license ${fromDocs.license?.exp_date || 'none'}, registration ${fromDocs.registration?.exp_date || 'none'}`);
    if (fromDocs.license && fromDocs.registration) return fromDocs;
    // Fall through to fill whichever half the documents did not provide.
  }

  // A "Property Registration and Rental Licensing" application grants BOTH, so
  // it has to count as a license as well — otherwise a property licensed
  // through the combined form looks unlicensed.
  //
  // Each record carries a single expirationDate, and which thing it refers to
  // is told by its shape: city registrations always run to Dec 31, while
  // licenses run 1-3 years from the inspection date. So a Dec 31 expiration is
  // read as the registration, anything else as the license.
  const nameOf = r => r.attributes.recordTypeName || '';
  const isRegType = r => /property registration/i.test(nameOf(r));
  // "Rental Licensing" and "Rental License Renewal Only" both match.
  const isLicType = r => /rental licen/i.test(nameOf(r));
  const endsOnDec31 = r => {
    const d = isoDate(r.attributes.expirationDate);
    return !!d && d.slice(5) === '12-31';
  };

  const regRows = rows.filter(r => isRegType(r) && endsOnDec31(r));
  const licRows = rows.filter(r => isLicType(r) && !endsOnDec31(r));

  const latest = list => list
    .filter(r => r.attributes.expirationDate)
    .sort((a, b) => new Date(b.attributes.expirationDate) - new Date(a.attributes.expirationDate))[0];

  return {
    registration: fromDocs.registration || toEntry(latest(regRows)),
    license: fromDocs.license || toEntry(latest(licRows)),
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
