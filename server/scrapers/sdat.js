'use strict';

const COUNTY_CODES = {
  baltimore_city:    '03',
  baltimore_county:  '02',
  harford:           '13',
};

// Parse "107 DURYEA DR, ABERDEEN, MD" → { number: '107', name: 'DURYEA DR' }
function parseAddress(address) {
  const street = address.split(',')[0].trim();
  const match = street.match(/^(\d+)\s+(.+)$/);
  if (!match) return null;
  return { number: match[1], name: match[2] };
}

async function lookupSdat(property) {
  const countyCode = COUNTY_CODES[property.municipality];
  if (!countyCode) return { error: `No SDAT county code for municipality: ${property.municipality}` };

  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  // Try REST API first
  try {
    const url = `https://sdat.dat.maryland.gov/RealProperty/api/v1/counties/${countyCode}/parcels` +
      `?streetNumber=${encodeURIComponent(parsed.number)}&streetName=${encodeURIComponent(parsed.name)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const data = await res.json();
      const parcels = Array.isArray(data) ? data : (data.results || data.parcels || []);
      if (parcels.length > 0) {
        const p = parcels[0];
        const yearBuilt = p.yearBuilt || p.year_built || p.YearBuilt || p.YEAR_BUILT || null;
        const sdatAcct = p.accountNumber || p.account_number || p.AccountNumber || p.ACCT_NO || null;
        if (yearBuilt) return { year_built: Number(yearBuilt), sdat_acct: sdatAcct };
      }
    }
  } catch (_) { /* fall through to Playwright */ }

  // Fallback: Playwright scrape
  return await scrapeSdatPlaywright(countyCode, parsed, property.municipality);
}

async function scrapeSdatPlaywright(countyCode, parsed, municipality) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('https://sdat.dat.maryland.gov/RealProperty/Pages/default.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Select county
    const countyLabels = {
      '02': 'BALTIMORE CO',
      '03': 'BALTIMORE CITY',
      '13': 'HARFORD',
    };
    const countyLabel = countyLabels[countyCode];
    const countySelect = page.locator('select').first();
    await countySelect.selectOption({ label: new RegExp(countyLabel, 'i') }).catch(async () => {
      // Try by value
      await countySelect.selectOption(countyCode);
    });

    await page.waitForTimeout(500);

    // Fill street number
    const numInput = page.locator('input[id*="StreetNumber"], input[name*="StreetNumber"], input[placeholder*="Street Number"]').first();
    await numInput.fill(parsed.number);

    // Fill street name (name only, no type)
    const nameOnly = parsed.name.replace(/\s+(ST|AVE|DR|RD|LN|CT|PL|WAY|BLVD|CIR|TER|TRL|PKWY|SQ|SQUARE|HWY|RTE|RT)\s*$/i, '').trim();
    const nameInput = page.locator('input[id*="StreetName"], input[name*="StreetName"], input[placeholder*="Street Name"]').first();
    await nameInput.fill(nameOnly);

    // Submit
    const searchBtn = page.locator('input[type="submit"], button[type="submit"]').first();
    await searchBtn.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Click first result link
    const resultLink = page.locator('a[href*="Parcel"], a[href*="parcel"], table a').first();
    const href = await resultLink.getAttribute('href').catch(() => null);
    if (!href) return { error: 'No SDAT results found' };
    await resultLink.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    // Extract year built
    const bodyText = await page.innerText('body');
    const ybMatch = bodyText.match(/year\s+built[:\s]+(\d{4})/i);
    const yearBuilt = ybMatch ? Number(ybMatch[1]) : null;

    // Extract account number
    const acctMatch = bodyText.match(/account\s*(?:number|#|no)[:\s]+([A-Z0-9\-]+)/i);
    const sdatAcct = acctMatch ? acctMatch[1].trim() : null;

    return { year_built: yearBuilt, sdat_acct: sdatAcct };
  } catch (err) {
    return { error: err.message };
  } finally {
    await browser.close();
  }
}

module.exports = { lookupSdat };
