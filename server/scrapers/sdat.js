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
  const full = match[2].trim();
  const nameOnly = full.replace(/\s+(ST|AVE|DR|RD|LN|CT|PL|WAY|BLVD|CIR|TER|TRL|PKWY|SQ|SQUARE|HWY|RTE|RT)\s*$/i, '').trim();
  return { number: match[1], name: full, nameOnly };
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
    page.setDefaultTimeout(60000);

    // SDAT uses ASP.NET WebForms — wait for full page load including scripts
    await page.goto('https://sdat.dat.maryland.gov/RealProperty/Pages/default.aspx', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    // Dump all select elements to find the right one
    const selects = await page.locator('select').all();
    console.log(`[sdat] Found ${selects.length} select elements on page`);

    let countySelect = null;
    for (const sel of selects) {
      const opts = await sel.locator('option').allTextContents().catch(() => []);
      // County dropdown will have many options including city/county names
      if (opts.length > 3) {
        countySelect = sel;
        console.log(`[sdat] County select options sample: ${opts.slice(0, 5).join(', ')}`);
        break;
      }
    }

    if (!countySelect) return { error: 'SDAT: county select not found on page' };

    // Try selecting by value first, then by partial text match
    const selected = await countySelect.selectOption({ value: countyCode }).catch(async () => {
      const opts = await countySelect.locator('option').all();
      for (const opt of opts) {
        const val = await opt.getAttribute('value').catch(() => '');
        if (val && val.includes(countyCode)) {
          return countySelect.selectOption({ value: val });
        }
      }
      return null;
    });

    if (!selected) return { error: `SDAT: could not select county code ${countyCode}` };

    // WebForms postback after county change — wait for it
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // Find street number input
    const allInputs = await page.locator('input[type="text"]').all();
    console.log(`[sdat] Found ${allInputs.length} text inputs after county select`);

    let numInput = null, nameInput = null;
    for (const inp of allInputs) {
      const id = (await inp.getAttribute('id') || '').toLowerCase();
      const name = (await inp.getAttribute('name') || '').toLowerCase();
      const ph = (await inp.getAttribute('placeholder') || '').toLowerCase();
      if (id.includes('number') || name.includes('number') || ph.includes('number')) {
        numInput = inp;
      } else if (id.includes('name') || name.includes('name') || ph.includes('name') || id.includes('street')) {
        nameInput = inp;
      }
    }

    // Fallback: first two visible text inputs after county select
    if (!numInput || !nameInput) {
      const visible = [];
      for (const inp of allInputs) {
        if (await inp.isVisible()) visible.push(inp);
      }
      console.log(`[sdat] Fallback: ${visible.length} visible inputs, using first two`);
      numInput = numInput || visible[0];
      nameInput = nameInput || visible[1];
    }

    if (!numInput || !nameInput) return { error: 'SDAT: could not find address input fields' };

    await numInput.fill(parsed.number);
    await nameInput.fill(parsed.nameOnly);

    // Submit
    const searchBtn = page.locator('input[type="submit"], button[type="submit"]').first();
    await searchBtn.click();

    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Find result link
    const resultLink = page.locator('a').filter({ hasText: /\d/ }).first();
    const linkText = await resultLink.textContent().catch(() => '');
    console.log(`[sdat] First result link text: "${linkText}"`);

    const href = await resultLink.getAttribute('href').catch(() => null);
    if (!href) {
      const bodyText = await page.innerText('body').catch(() => '');
      console.log(`[sdat] No result link. Page excerpt: ${bodyText.slice(0, 300)}`);
      return { error: 'SDAT: no results found for this address' };
    }

    await resultLink.click();
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const bodyText = await page.innerText('body');
    const ybMatch = bodyText.match(/year\s*built[:\s]+(\d{4})/i);
    const yearBuilt = ybMatch ? Number(ybMatch[1]) : null;
    const acctMatch = bodyText.match(/account\s*(?:number|#|no\.?)[:\s]+([A-Z0-9\-\s]{4,30}?)(?:\n|\r|$)/i);
    const sdatAcct = acctMatch ? acctMatch[1].trim() : null;

    if (!yearBuilt) {
      console.log(`[sdat] Parcel page excerpt: ${bodyText.slice(0, 500)}`);
      return { error: 'SDAT: property found but year built not present on detail page' };
    }

    return { year_built: yearBuilt, sdat_acct: sdatAcct };
  } catch (err) {
    return { error: `SDAT scrape failed: ${err.message}` };
  } finally {
    await browser.close();
  }
}

module.exports = { lookupSdat };
