'use strict';

const COUNTY_CODES = {
  baltimore_city:   '03',
  baltimore_county: '02',
  harford:          '13',
};

function parseAddress(address) {
  const street = address.split(',')[0].trim();
  const match = street.match(/^(\d+)\s+(.+)$/);
  if (!match) return null;
  // Strip common suffix for street name field (SDAT wants name without suffix)
  const full = match[2].trim();
  const nameOnly = full.replace(/\s+(ST|AVE|DR|RD|LN|CT|PL|WAY|BLVD|CIR|TER|TRL|PKWY|SQ|SQUARE|HWY|RTE|RT)\s*$/i, '').trim();
  return { number: match[1], name: match[2], nameOnly };
}

async function lookupSdat(property) {
  const countyCode = COUNTY_CODES[property.municipality];
  if (!countyCode) return { error: `No SDAT county code for municipality: ${property.municipality}` };

  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  return await scrapeSdatPlaywright(countyCode, parsed);
}

async function scrapeSdatPlaywright(countyCode, parsed) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(45000);

    await page.goto('https://sdat.dat.maryland.gov/RealProperty/Pages/default.aspx', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    // Wait for county dropdown to be present
    const countySelect = page.locator('select').first();
    await countySelect.waitFor({ state: 'visible', timeout: 20000 });

    // Select by value (county code) which is more reliable than label text
    await countySelect.selectOption({ value: countyCode }).catch(async () => {
      // Fallback: try selecting by index based on county
      const opts = await countySelect.locator('option').all();
      for (const opt of opts) {
        const val = await opt.getAttribute('value');
        const text = await opt.textContent();
        if (val === countyCode || (text && text.includes(countyCode))) {
          await countySelect.selectOption({ value: val || '' });
          break;
        }
      }
    });

    // Wait for the page to update after county selection (postback)
    await page.waitForTimeout(1500);
    await page.waitForLoadState('domcontentloaded');

    // Fill street number — try multiple selector strategies
    const numInput = page.locator([
      'input[id*="StreetNumber"]',
      'input[name*="StreetNumber"]',
      'input[placeholder*="Street Number" i]',
      'input[id*="txtStreet"][id*="Num"]',
    ].join(', ')).first();
    await numInput.waitFor({ state: 'visible', timeout: 15000 });
    await numInput.fill(parsed.number);

    // Fill street name
    const nameInput = page.locator([
      'input[id*="StreetName"]',
      'input[name*="StreetName"]',
      'input[placeholder*="Street Name" i]',
      'input[id*="txtStreet"][id*="Nam"]',
    ].join(', ')).first();
    await nameInput.fill(parsed.nameOnly);

    // Submit
    const searchBtn = page.locator('input[type="submit"], button[type="submit"]').first();
    await searchBtn.click();

    // Wait for results to load
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Look for a results link to a parcel detail page
    const resultLink = page.locator('a[href*="Detail"], a[href*="Parcel"], a[href*="parcel"], table.DataGrid a, table a').first();
    const href = await resultLink.getAttribute('href').catch(() => null);
    if (!href) {
      // Check if "no results" message shown
      const bodyText = await page.innerText('body').catch(() => '');
      if (bodyText.toLowerCase().includes('no results') || bodyText.toLowerCase().includes('no records')) {
        return { error: 'No SDAT results found for this address' };
      }
      return { error: 'SDAT: could not find result link — page may have changed' };
    }

    await resultLink.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    const bodyText = await page.innerText('body');
    const ybMatch = bodyText.match(/year\s*built[:\s]+(\d{4})/i);
    const yearBuilt = ybMatch ? Number(ybMatch[1]) : null;

    const acctMatch = bodyText.match(/account\s*(?:number|#|no\.?)[:\s]+([A-Z0-9\-\s]+?)(?:\n|<)/i);
    const sdatAcct = acctMatch ? acctMatch[1].trim().replace(/\s+/g, ' ') : null;

    if (!yearBuilt) return { error: 'SDAT: property found but year built not on page' };

    return { year_built: yearBuilt, sdat_acct: sdatAcct };
  } catch (err) {
    return { error: `SDAT scrape failed: ${err.message}` };
  } finally {
    await browser.close();
  }
}

module.exports = { lookupSdat };
