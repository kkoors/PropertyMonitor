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
    const licenseNumber = f.B1_RECORD_ID || null;

    const result = { license_number: licenseNumber, status, issue_date: issueDate, exp_date: expDate };

    // Try to download the license certificate PDF from the Accela citizen portal
    if (licenseNumber) {
      const pdf = await downloadLicensePdf(licenseNumber);
      if (pdf) result.confirmation_letter = pdf;
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
