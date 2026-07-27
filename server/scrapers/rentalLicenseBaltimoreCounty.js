'use strict';

const BASE = 'https://bcgisapps.baltimorecountymd.gov/arcgis/rest/services/RentalLicense/MapServer/0/query';

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

// The county spells out "SAINT FABIAN" / "MOUNT ROYAL" where addresses are
// usually abbreviated, so search every spelling of the name at once.
function nameVariants(name) {
  const out = new Set([name]);
  const swap = (from, to) => {
    if (name.startsWith(`${from} `)) out.add(`${to} ${name.slice(from.length + 1)}`);
  };
  swap('ST', 'SAINT'); swap('SAINT', 'ST');
  swap('MT', 'MOUNT'); swap('MOUNT', 'MT');
  swap('FT', 'FORT'); swap('FORT', 'FT');
  for (const v of [...out]) {
    if (v.includes("'")) out.add(v.replace(/'/g, ''));
  }
  return [...out];
}

async function scrapeRentalLicenseBaltimoreCounty(property, { downloadPdf = false } = {}) {
  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  const nameClause = nameVariants(parsed.name)
    .map(v => `UPPER(B1_STR_NAME) LIKE '${v.replace(/'/g, "''")}%'`)
    .join(' OR ');
  const where = `B1_HSE_NBR_START=${parsed.number} AND (${nameClause})`;
  const params = new URLSearchParams({
    where,
    outFields: '*',
    f: 'json',
    resultRecordCount: '50',
  });

  try {
    const res = await fetch(`${BASE}?${params}`);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();

    if (!data.features || data.features.length === 0) {
      return { license_number: null, status: 'not_found', exp_date: null, licenses: [] };
    }

    // One record per licensed unit — keep the latest expiration per unit
    const byUnit = new Map();
    for (const { attributes: f } of data.features) {
      const unit = f.B1_UNIT_START != null && f.B1_UNIT_START !== '' ? String(f.B1_UNIT_START) : '';
      const prev = byUnit.get(unit);
      if (!prev || (f.EXPIRATION_DATE || 0) > (prev.EXPIRATION_DATE || 0)) byUnit.set(unit, f);
    }

    const licenses = [...byUnit.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([unit, f]) => {
        const expDate = f.EXPIRATION_DATE ? new Date(f.EXPIRATION_DATE).toISOString().slice(0, 10) : null;
        return {
          unit,
          license_number: f.B1_RECORD_ID || null,
          status: normalizeStatus(f.B1_APPL_STATUS, expDate),
          issue_date: f.ISSUE_DATE ? new Date(f.ISSUE_DATE).toISOString().slice(0, 10) : null,
          exp_date: expDate,
        };
      });
    console.log(`[balt-county] ${parsed.number} ${parsed.name}: ${licenses.length} unit license(s): ${licenses.map(l => `${l.unit || '(whole)'}=${l.status}`).join(', ')}`);

    // Back-compat top-level = first (or only) license
    const best = licenses.find(l => l.status === 'active') || licenses[0];
    const result = { ...best, licenses };

    // Fetching the certificate PDF spins up a headless browser against the
    // Accela portal, which takes ~30s and usually returns an error page — far
    // too slow to run on every check, so it happens only when asked for.
    if (downloadPdf && best.license_number) {
      const pdf = await downloadLicensePdf(best.license_number);
      if (pdf) result.confirmation_letter = pdf;
      else result.pdf_error = 'Certificate not available from the county portal';
    }

    return result;
  } catch (err) {
    return { error: err.message };
  }
}

async function downloadLicensePdf(recordId) {
  const { chromium } = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);

    // Navigate to the Accela record detail page directly by alt_id
    const detailUrl = `https://citizenaccess.baltimorecountymd.gov/CitizenAccess/Cap/CapDetail.aspx?alt_id=${encodeURIComponent(recordId)}`;
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    console.log(`[balt-county] Accela record page for ${recordId}: ${page.url()}`);

    // Look for a print/certificate/download link
    const pdfLink = page.locator([
      'a:has-text("Print License")',
      'a:has-text("Print Certificate")',
      'a:has-text("Certificate")',
      'a:has-text("Download")',
      'a[href*="PrintForm"]',
      'a[href$=".pdf" i]',
    ].join(', ')).first();

    const href = await pdfLink.getAttribute('href').catch(() => null);
    if (!href) {
      console.log(`[balt-county] No PDF link found for ${recordId}`);
      return null;
    }

    const pdfUrl = href.startsWith('http') ? href : new URL(href, page.url()).href;
    console.log(`[balt-county] Downloading PDF: ${pdfUrl}`);
    const pdfRes = await fetch(pdfUrl, { signal: AbortSignal.timeout(15000) });
    if (!pdfRes.ok) return null;

    const buf = Buffer.from(await pdfRes.arrayBuffer());
    console.log(`[balt-county] Downloaded PDF: ${buf.length} bytes`);
    return buf;
  } catch (err) {
    console.log(`[balt-county] PDF download error: ${err.message}`);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
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
