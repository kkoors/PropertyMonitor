'use strict';

function parseAddress(address) {
  const street = address.split(',')[0].trim();
  const match = street.match(/^(\d+)\s+(.+)$/);
  if (!match) return null;
  const parts = match[2].trim().split(/\s+/);
  const suffixes = new Set(['ST', 'AVE', 'DR', 'RD', 'LN', 'CT', 'PL', 'WAY', 'BLVD', 'CIR', 'TER', 'TRL', 'PKWY', 'SQ', 'HWY']);
  const last = parts[parts.length - 1].toUpperCase();
  const hasSuffix = suffixes.has(last);
  const name = hasSuffix ? parts.slice(0, -1).join(' ') : parts.join(' ');
  return { number: match[1], name: name.toUpperCase(), full: match[2].toUpperCase() };
}

// Use Open Baltimore Socrata catalog to discover the rental registration dataset
async function discoverDataset(parsed) {
  const searches = ['rental registration', 'rental license', 'dhcd registration'];
  for (const q of searches) {
    try {
      const res = await fetch(
        `https://data.baltimorecity.gov/api/catalog/v1?${new URLSearchParams({ q, limit: '10' })}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) continue;
      const catalog = await res.json();
      const datasets = catalog.results || [];
      console.log(`[balt-city] catalog "${q}":`, datasets.map(d => `${d.resource?.id} — ${d.resource?.name}`).join('\n  ') || '(none)');

      for (const ds of datasets) {
        const id = ds.resource?.id;
        if (!id) continue;
        const result = await queryDataset(id, parsed);
        if (result) return result;
      }
    } catch (err) {
      console.log(`[balt-city] catalog error for "${q}": ${err.message}`);
    }
  }
  return null;
}

async function queryDataset(datasetId, parsed) {
  const url = `https://data.baltimorecity.gov/resource/${datasetId}.json`;
  try {
    // Probe for column names
    const probe = await fetch(`${url}?$limit=1`, { signal: AbortSignal.timeout(8000) });
    if (!probe.ok) { console.log(`[balt-city] ${datasetId} → ${probe.status}`); return null; }
    const contentType = probe.headers.get('content-type') || '';
    if (!contentType.includes('json')) return null;
    const sample = await probe.json();
    if (!Array.isArray(sample) || sample.length === 0) return null;

    const cols = Object.keys(sample[0]);
    console.log(`[balt-city] dataset ${datasetId} (${sample[0].name || ''}) cols:`, cols.join(', '));

    // Identify house number and street name columns
    const numCol  = cols.find(c => /house|hse_nbr|premise|blk_nbr|^no$|addr.*no/i.test(c));
    const nameCol = cols.find(c => /street.*name|st_name|streetname|str_nam/i.test(c));
    if (!numCol || !nameCol) {
      console.log(`[balt-city] ${datasetId}: no num/name cols (num=${numCol} name=${nameCol})`);
      return null;
    }

    // Query by house number
    const q = new URLSearchParams({ $where: `${numCol}='${parsed.number}'`, $limit: '20' });
    const res = await fetch(`${url}?${q}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log(`[balt-city] ${datasetId}: no rows for house# ${parsed.number}`);
      return null;
    }
    console.log(`[balt-city] ${datasetId}: ${rows.length} rows for house# ${parsed.number}`);

    // Match street name
    const row = rows.find(r => {
      const sn = (r[nameCol] || '').toUpperCase().replace(/\s+/g, ' ');
      return sn.includes(parsed.name) || parsed.name.includes(sn.replace(/\s+(ST|AVE|DR|RD|LN|CT|PL)$/, '').trim());
    }) || rows[0];

    console.log(`[balt-city] matched row:`, JSON.stringify(row));
    return normalizeRow(row, cols);
  } catch (err) {
    console.log(`[balt-city] ${datasetId} query error: ${err.message}`);
    return null;
  }
}

async function scrapeRentalLicenseBaltimoreCity(property) {
  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  console.log(`[balt-city] Looking up: "${property.address}" → number=${parsed.number} name=${parsed.name}`);

  // Try catalog discovery
  const sodaResult = await discoverDataset(parsed);
  if (sodaResult) return sodaResult;

  // Playwright fallback — try DHCD housing portal
  return await scrapeViaDhcd(property, parsed);
}

async function scrapeViaDhcd(property, parsed) {
  const { chromium } = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    // Try the DHCD main site and look for rental registration
    const urls = [
      'https://dhcd.baltimorecity.gov/',
      'https://www.baltimorecity.gov/government/departments-offices/housing-and-community-development',
    ];

    for (const startUrl of urls) {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      const title = await page.title().catch(() => '');
      const currentUrl = page.url();
      console.log(`[balt-city playwright] ${startUrl} → "${title}" (${currentUrl})`);

      // Look for a rental registration link
      const regLink = page.locator('a:has-text("Rental Registration"), a:has-text("Registration Search"), a[href*="rental"]').first();
      if (await regLink.isVisible().catch(() => false)) {
        console.log('[balt-city playwright] Found rental registration link');
        await regLink.click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        break;
      }
    }

    const finalTitle = await page.title().catch(() => '');
    const finalUrl = page.url();
    console.log(`[balt-city playwright] Final: "${finalTitle}" (${finalUrl})`);

    const inputs = await page.locator('input[type="text"]:visible').all();
    console.log(`[balt-city playwright] visible text inputs: ${inputs.length}`);
    for (let i = 0; i < inputs.length; i++) {
      const id = await inputs[i].getAttribute('id').catch(() => '');
      const ph = await inputs[i].getAttribute('placeholder').catch(() => '');
      console.log(`  input[${i}] id="${id}" placeholder="${ph}"`);
    }

    if (inputs.length < 2) {
      const links = await page.locator('a').allTextContents().catch(() => []);
      console.log('[balt-city playwright] Links on page:', links.filter(l => l.trim()).slice(0, 20).join(' | '));
      return { error: 'Baltimore City rental registration lookup: DHCD search form not found. Please enter license info manually.' };
    }

    await inputs[0].fill(parsed.number).catch(() => {});
    if (inputs[1]) await inputs[1].fill(parsed.name).catch(() => {});

    const btn = page.locator('input[type="submit"], button[type="submit"], button:has-text("Search")').first();
    await btn.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const bodyText = await page.innerText('body').catch(() => '');
    console.log('[balt-city playwright] body:', bodyText.slice(0, 500));

    const result = parseResultText(bodyText);

    // Try to download confirmation letter PDF
    const pdfLink = page.locator([
      'a:has-text("Confirmation Letter")',
      'a:has-text("Registration Letter")',
      'a:has-text("Download")',
      'a[href$=".pdf" i]',
    ].join(', ')).first();

    const pdfHref = await pdfLink.getAttribute('href').catch(() => null);
    if (pdfHref) {
      console.log(`[balt-city playwright] Found PDF link: ${pdfHref}`);
      try {
        const pdfUrl = pdfHref.startsWith('http') ? pdfHref : new URL(pdfHref, page.url()).href;
        const pdfRes = await fetch(pdfUrl, { signal: AbortSignal.timeout(15000) });
        if (pdfRes.ok) {
          result.confirmation_letter = Buffer.from(await pdfRes.arrayBuffer());
          console.log(`[balt-city playwright] Downloaded PDF: ${result.confirmation_letter.length} bytes`);
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

function normalizeRow(row, cols) {
  const pick = (...patterns) => {
    const col = cols.find(c => patterns.some(p => p.test(c)));
    return col ? row[col] : null;
  };
  const expDate   = normalizeDate(pick(/expir/i, /exp_dt/i));
  const issueDate = normalizeDate(pick(/issue/i, /iss_dt/i, /start/i, /reg_dt/i));
  const licNum    = pick(/^license_no$/i, /^cert.*no$/i, /^reg.*no$/i, /^record_id$/i) || null;
  const statusRaw = pick(/^status$/i, /reg.*status/i, /appl.*status/i) || null;
  return { license_number: licNum, status: deriveStatus(statusRaw, expDate), issue_date: issueDate, exp_date: expDate };
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
