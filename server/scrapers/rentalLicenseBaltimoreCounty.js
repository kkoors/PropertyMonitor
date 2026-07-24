'use strict';

const BASE = 'https://bcgisapps.baltimorecountymd.gov/arcgis/rest/services/RentalLicense/MapServer/0/query';

function parseAddress(address) {
  const street = address.split(',')[0].trim();
  const match = street.match(/^(\d+)\s+(.+)$/);
  if (!match) return null;
  const parts = match[2].trim().split(/\s+/);
  const suffixes = new Set(['ST', 'AVE', 'DR', 'RD', 'LN', 'CT', 'PL', 'WAY', 'BLVD', 'CIR', 'TER', 'TRL', 'PKWY', 'SQ', 'HWY']);
  const last = parts[parts.length - 1].toUpperCase();
  const suffix = suffixes.has(last) ? last : '';
  const name = suffix ? parts.slice(0, -1).join(' ') : parts.join(' ');
  return { number: match[1], name: name.toUpperCase(), suffix };
}

async function scrapeRentalLicenseBaltimoreCounty(property) {
  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  const where = `B1_HSE_NBR_START=${parsed.number} AND UPPER(B1_STR_NAME) LIKE '${parsed.name.replace(/'/g, "''")}'`;
  const params = new URLSearchParams({
    where,
    outFields: '*',
    f: 'json',
    resultRecordCount: '5',
  });

  try {
    const res = await fetch(`${BASE}?${params}`);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();

    if (!data.features || data.features.length === 0) {
      return { license_number: null, status: 'not_found', exp_date: null };
    }

    const f = data.features[0].attributes;
    const expDate = f.EXPIRATION_DATE ? new Date(f.EXPIRATION_DATE).toISOString().slice(0, 10) : null;
    const issueDate = f.ISSUE_DATE ? new Date(f.ISSUE_DATE).toISOString().slice(0, 10) : null;
    const status = normalizeStatus(f.B1_APPL_STATUS, expDate);

    return {
      license_number: f.B1_RECORD_ID || null,
      status,
      issue_date: issueDate,
      exp_date: expDate,
    };
  } catch (err) {
    return { error: err.message };
  }
}

function normalizeStatus(raw, expDate) {
  if (!raw) return 'unknown';
  const s = raw.toString().toUpperCase();
  if (s.includes('ISSUED') || s.includes('ACTIVE') || s.includes('APPROVED')) {
    if (expDate && new Date(expDate) < new Date()) return 'expired';
    return 'active';
  }
  if (s.includes('EXPIRED')) return 'expired';
  if (s.includes('VOID') || s.includes('CANCEL')) return 'cancelled';
  if (s.includes('PENDING') || s.includes('REVIEW')) return 'pending';
  return 'unknown';
}

module.exports = { scrapeRentalLicenseBaltimoreCounty };
