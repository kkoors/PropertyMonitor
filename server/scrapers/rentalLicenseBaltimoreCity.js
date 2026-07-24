'use strict';

// Baltimore City rental registration & licensing — city GIS layer, updated daily from OpenGov.
const BASE = 'https://geodata.baltimorecity.gov/egis/rest/services/Housing/OpenGov_RegAndLicense/MapServer/0/query';

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

function msToDate(ms) {
  if (!ms) return null;
  const d = new Date(Number(ms));
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function scrapeRentalLicenseBaltimoreCity(property) {
  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  // Address field is a single string like "1401 BATTERY AVE, Baltimore, MD 21230"
  const dirPart = parsed.dir ? `${parsed.dir[0]} ` : '';
  const prefix = `${parsed.number} ${dirPart}${parsed.name}`.replace(/'/g, "''");
  const params = new URLSearchParams({
    where: `UPPER(Address) LIKE '${prefix}%'`,
    outFields: '*',
    f: 'json',
    resultRecordCount: '10',
  });

  try {
    const res = await fetch(`${BASE}?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { error: `Baltimore City reg/license HTTP ${res.status}` };
    const data = await res.json();
    if (data.error) return { error: `Baltimore City reg/license: ${data.error.message}` };

    const features = (data.features || []).map(f => f.attributes);
    console.log(`[balt-city] OpenGov_RegAndLicense: ${features.length} rows for '${prefix}%'`);
    if (features.length === 0) {
      return { license_number: null, status: 'not_found', exp_date: null };
    }

    // "Yes" rows are the rental LICENSE; "No" rows are the REGISTRATION record.
    const toEntry = f => {
      if (!f) return null;
      const expDate = msToDate(f.LicenseExpirationDate);
      return {
        license_number: f.RecordNUMBER != null ? String(f.RecordNUMBER) : null,
        status: expDate && new Date(expDate) < new Date() ? 'expired' : 'active',
        issue_date: msToDate(f.LicenseIssuedDate),
        exp_date: expDate,
        dwelling_count: f.DwellingCount ?? null,
        block_lot: f.BlockLot || null,
      };
    };
    const latest = rows => rows.sort((a, b) => (b.LicenseExpirationDate || 0) - (a.LicenseExpirationDate || 0))[0];

    const license = toEntry(latest(features.filter(f => f.LicenceOrRegistration === 'Yes')));
    const registration = toEntry(latest(features.filter(f => f.LicenceOrRegistration === 'No')));

    // Back-compat top-level fields = license (falls back to not_licensed if only registered)
    return {
      ...(license || { license_number: registration?.license_number || null, status: 'not_licensed', issue_date: registration?.issue_date || null, exp_date: null }),
      license,
      registration,
    };
  } catch (err) {
    return { error: `Baltimore City reg/license error: ${err.message}` };
  }
}

module.exports = { scrapeRentalLicenseBaltimoreCity };
