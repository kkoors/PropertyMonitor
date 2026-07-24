'use strict';

// Baltimore City rental registration — Open Baltimore Socrata API
// Dataset: Rental Registrations https://data.baltimorecity.gov/resource/ybmg-3rqy.json
const SODA_BASE = 'https://data.baltimorecity.gov/resource/ybmg-3rqy.json';

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
  return { number: match[1], name: name.toUpperCase(), suffix };
}

async function scrapeRentalLicenseBaltimoreCity(property) {
  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  // Try Socrata API first
  try {
    const params = new URLSearchParams({
      $where: `house_no='${parsed.number}' AND UPPER(street_name) LIKE '${parsed.name.replace(/'/g, "''")}%'`,
      $limit: '5',
    });
    const res = await fetch(`${SODA_BASE}?${params}`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const rows = await res.json();
      if (rows && rows.length > 0) {
        return normalizeRow(rows[0]);
      }
      // Try looser match if exact fails
      const params2 = new URLSearchParams({
        $where: `house_no='${parsed.number}'`,
        $limit: '10',
      });
      const res2 = await fetch(`${SODA_BASE}?${params2}`, { signal: AbortSignal.timeout(10000) });
      if (res2.ok) {
        const rows2 = await res2.json();
        const match = rows2.find(r => r.street_name && r.street_name.toUpperCase().includes(parsed.name));
        if (match) return normalizeRow(match);
      }
    }
  } catch (err) {
    console.warn('[balt-city-license] Socrata API failed, trying Playwright:', err.message);
  }

  // Playwright fallback — DHCD rental registration portal
  return await scrapeViaDhcd(property, parsed);
}

async function scrapeViaDhcd(property, parsed) {
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto('https://dhcd.baltimorecity.gov/Rental/Registration/Search', {
      timeout: 30000, waitUntil: 'domcontentloaded',
    });

    // Try to fill in house number + street name search fields
    const houseInput = await page.$('input[name*="house"], input[id*="house"], input[placeholder*="house" i], input[placeholder*="number" i]');
    const streetInput = await page.$('input[name*="street"], input[id*="street"], input[placeholder*="street" i]');

    if (houseInput && streetInput) {
      await houseInput.fill(parsed.number);
      await streetInput.fill(parsed.name);
      await page.keyboard.press('Enter');
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      const text = await page.textContent('body');
      return parseResultText(text);
    }

    return { license_number: null, status: 'not_found', exp_date: null };
  } catch (err) {
    return { error: `Playwright failed: ${err.message}` };
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

  // Try to pull expiration date
  const expMatch = text.match(/expir\w*[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  const expDate = expMatch ? normalizeDate(expMatch[1]) : null;
  const certMatch = text.match(/certificate[:\s#]+([A-Z0-9\-]+)/i);
  const licenseNumber = certMatch ? certMatch[1] : null;

  return {
    license_number: licenseNumber,
    status: expDate && new Date(expDate) > new Date() ? 'active' : 'unknown',
    exp_date: expDate,
    issue_date: null,
  };
}

function normalizeRow(row) {
  // Field names vary by dataset version — try common ones
  const expRaw = row.expiration_date || row.exp_date || row.expiry_date || null;
  const issueRaw = row.issue_date || row.issued_date || row.start_date || null;
  const licNum = row.license_no || row.certificate_no || row.registration_no || row.record_id || null;
  const statusRaw = row.status || row.registration_status || row.appl_status || null;

  const expDate = expRaw ? normalizeDate(expRaw) : null;
  const issueDate = issueRaw ? normalizeDate(issueRaw) : null;
  const status = deriveStatus(statusRaw, expDate);

  return { license_number: licNum, status, issue_date: issueDate, exp_date: expDate };
}

function normalizeDate(val) {
  if (!val) return null;
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch { return null; }
}

function deriveStatus(raw, expDate) {
  if (expDate && new Date(expDate) < new Date()) return 'expired';
  if (!raw) return expDate ? 'active' : 'unknown';
  const s = raw.toString().toUpperCase();
  if (s.includes('ACTIVE') || s.includes('ISSUED') || s.includes('CURRENT') || s.includes('VALID')) return 'active';
  if (s.includes('EXPIR')) return 'expired';
  if (s.includes('VOID') || s.includes('CANCEL')) return 'cancelled';
  if (s.includes('PENDING')) return 'pending';
  return 'unknown';
}

module.exports = { scrapeRentalLicenseBaltimoreCity };
