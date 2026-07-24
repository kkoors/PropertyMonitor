'use strict';

// Baltimore City rental registration lookup.
// The Open Baltimore Socrata dataset ID for rental registrations is not publicly confirmed —
// this scraper tries the API and falls back to Playwright against the DHCD property search.

function parseAddress(address) {
  const street = address.split(',')[0].trim();
  const match = street.match(/^(\d+)\s+(.+)$/);
  if (!match) return null;
  const parts = match[2].trim().split(/\s+/);
  const suffixes = new Set(['ST', 'AVE', 'DR', 'RD', 'LN', 'CT', 'PL', 'WAY', 'BLVD', 'CIR', 'TER', 'TRL', 'PKWY', 'SQ', 'HWY']);
  const last = parts[parts.length - 1].toUpperCase();
  const hasSuffix = suffixes.has(last);
  const name = hasSuffix ? parts.slice(0, -1).join(' ') : parts.join(' ');
  const suffix = hasSuffix ? last : '';
  return { number: match[1], name: name.toUpperCase(), suffix, full: match[2].toUpperCase() };
}

// Known candidate dataset IDs on data.baltimorecity.gov for rental registrations
const SODA_CANDIDATES = [
  { id: 'ybmg-3rqy', numField: 'house_no',     nameField: 'street_name' },
  { id: 'feu4-bfkc', numField: 'blocknumber',   nameField: 'streetname'  },
  { id: '5cxy-crxi', numField: 'house_number',  nameField: 'street_name' },
  { id: 'w4th-47vz', numField: 'premise_no',    nameField: 'st_name'     },
];

async function trySODA(parsed) {
  for (const ds of SODA_CANDIDATES) {
    try {
      const url = `https://data.baltimorecity.gov/resource/${ds.id}.json`;
      // First: fetch one record to verify dataset exists and log column names
      const probe = await fetch(`${url}?$limit=1`, { signal: AbortSignal.timeout(8000) });
      if (!probe.ok) {
        console.log(`[balt-city] dataset ${ds.id} → ${probe.status}`);
        continue;
      }
      const sample = await probe.json();
      if (!Array.isArray(sample) || sample.length === 0) {
        console.log(`[balt-city] dataset ${ds.id} exists but is empty`);
        continue;
      }
      console.log(`[balt-city] dataset ${ds.id} cols:`, Object.keys(sample[0]).join(', '));

      // Check if expected columns exist
      if (!(ds.numField in sample[0]) || !(ds.nameField in sample[0])) {
        console.log(`[balt-city] dataset ${ds.id} missing expected fields ${ds.numField}/${ds.nameField}`);
        continue;
      }

      // Query by house number only first (more permissive)
      const q = new URLSearchParams({
        $where: `${ds.numField}='${parsed.number}'`,
        $limit: '20',
      });
      const res = await fetch(`${url}?${q}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const rows = await res.json();
      console.log(`[balt-city] dataset ${ds.id}: ${rows.length} rows for house# ${parsed.number}`);
      if (rows.length === 0) continue;

      // Find matching street name
      const match = rows.find(r => {
        const sn = (r[ds.nameField] || '').toUpperCase();
        return sn.includes(parsed.name) || parsed.name.includes(sn.replace(/\s+(ST|AVE|DR|RD|LN|CT|PL)$/, '').trim());
      }) || rows[0];

      console.log(`[balt-city] matched row:`, JSON.stringify(match));
      return normalizeRow(match);
    } catch (err) {
      console.log(`[balt-city] dataset ${ds.id} error: ${err.message}`);
    }
  }
  return null;
}

async function scrapeRentalLicenseBaltimoreCity(property) {
  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  console.log(`[balt-city] Looking up: ${property.address} → number=${parsed.number} name=${parsed.name}`);

  // Try Socrata datasets
  const sodaResult = await trySODA(parsed);
  if (sodaResult) return sodaResult;

  // Playwright fallback — DHCD property search
  return await scrapeViaDhcd(property, parsed);
}

async function scrapeViaDhcd(property, parsed) {
  const { chromium } = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    // DHCD rental registration lookup
    await page.goto('https://dhcd.baltimorecity.gov/Rental/Registration/Search', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    }).catch(async () => {
      // Try alternate DHCD URL
      await page.goto('https://dhcd.baltimorecity.gov/', {
        waitUntil: 'domcontentloaded', timeout: 20000,
      }).catch(() => {});
    });

    const title = await page.title().catch(() => '');
    const url   = page.url();
    console.log(`[balt-city playwright] title="${title}" url="${url}"`);

    // Look for any search/input forms
    const inputs = await page.locator('input[type="text"]').all();
    console.log(`[balt-city playwright] text inputs: ${inputs.length}`);
    for (let i = 0; i < inputs.length; i++) {
      const id = await inputs[i].getAttribute('id').catch(() => '');
      const ph = await inputs[i].getAttribute('placeholder').catch(() => '');
      console.log(`  input[${i}] id="${id}" placeholder="${ph}"`);
    }

    if (inputs.length === 0) {
      console.log('[balt-city playwright] no inputs found — DHCD URL may have changed');
      return { error: 'Baltimore City rental registration lookup unavailable — please enter manually' };
    }

    // Try house number in first input, street name in second
    await inputs[0].fill(parsed.number).catch(() => {});
    if (inputs[1]) await inputs[1].fill(parsed.name).catch(() => {});

    const btn = page.locator('input[type="submit"], button[type="submit"], button:has-text("Search")').first();
    await btn.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const bodyText = await page.innerText('body').catch(() => '');
    console.log('[balt-city playwright] body excerpt:', bodyText.slice(0, 400));

    const result = parseResultText(bodyText);

    // Try to download the Property Registration Confirmation Letter
    const pdfLink = page.locator([
      'a:has-text("Confirmation Letter")',
      'a:has-text("Registration Letter")',
      'a:has-text("Download")',
      'a[href$=".pdf" i]',
      'a[href*="letter" i]',
      'a[href*="confirmation" i]',
    ].join(', ')).first();

    const pdfHref = await pdfLink.getAttribute('href').catch(() => null);
    if (pdfHref) {
      console.log(`[balt-city playwright] Found PDF link: ${pdfHref}`);
      try {
        const pdfUrl = pdfHref.startsWith('http') ? pdfHref : new URL(pdfHref, page.url()).href;
        const [ download ] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
          pdfLink.click(),
        ]);
        if (download) {
          const stream = await download.createReadStream();
          const chunks = [];
          await new Promise((resolve, reject) => {
            stream.on('data', c => chunks.push(c));
            stream.on('end', resolve);
            stream.on('error', reject);
          });
          result.confirmation_letter = Buffer.concat(chunks);
          console.log(`[balt-city playwright] Downloaded PDF: ${result.confirmation_letter.length} bytes`);
        } else {
          // Direct fetch fallback
          const pdfRes = await fetch(pdfUrl, { signal: AbortSignal.timeout(15000) });
          if (pdfRes.ok) {
            result.confirmation_letter = Buffer.from(await pdfRes.arrayBuffer());
            console.log(`[balt-city playwright] Fetched PDF: ${result.confirmation_letter.length} bytes`);
          }
        }
      } catch (err) {
        console.log(`[balt-city playwright] PDF download failed: ${err.message}`);
      }
    }

    return result;
  } catch (err) {
    console.log('[balt-city playwright] error:', err.message);
    return { error: `Baltimore City registration lookup failed: ${err.message}` };
  } finally {
    if (browser) await browser.close();
  }
}

function parseResultText(text) {
  if (!text) return { license_number: null, status: 'not_found', exp_date: null };
  const t = text.toLowerCase();
  if (t.includes('no result') || t.includes('not found') || t.includes('no record')) {
    return { license_number: null, status: 'not_found', exp_date: null };
  }
  const expMatch = text.match(/expir\w*[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  const expDate = expMatch ? normalizeDate(expMatch[1]) : null;
  const certMatch = text.match(/(?:certificate|registration|license)[:\s#]+([A-Z0-9\-]+)/i);
  return {
    license_number: certMatch ? certMatch[1] : null,
    status: expDate && new Date(expDate) > new Date() ? 'active' : 'unknown',
    exp_date: expDate,
    issue_date: null,
  };
}

function normalizeRow(row) {
  const expRaw   = row.expiration_date || row.exp_date || row.expiry_date || row.expire_date || null;
  const issueRaw = row.issue_date || row.issued_date || row.start_date   || row.reg_date    || null;
  const licNum   = row.license_no  || row.certificate_no || row.registration_no || row.record_id || row.reg_no || null;
  const statusRaw= row.status || row.registration_status || row.appl_status || null;
  const expDate  = normalizeDate(expRaw);
  const issDate  = normalizeDate(issueRaw);
  return { license_number: licNum, status: deriveStatus(statusRaw, expDate), issue_date: issDate, exp_date: expDate };
}

function normalizeDate(val) {
  if (!val) return null;
  try {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  } catch { return null; }
}

function deriveStatus(raw, expDate) {
  if (expDate && new Date(expDate) < new Date()) return 'expired';
  if (!raw) return expDate ? 'active' : 'unknown';
  const s = raw.toString().toUpperCase();
  if (s.includes('ACTIVE') || s.includes('ISSUED') || s.includes('CURRENT') || s.includes('VALID')) return 'active';
  if (s.includes('EXPIR')) return 'expired';
  if (s.includes('VOID') || s.includes('CANCEL')) return 'cancelled';
  return 'unknown';
}

module.exports = { scrapeRentalLicenseBaltimoreCity };
