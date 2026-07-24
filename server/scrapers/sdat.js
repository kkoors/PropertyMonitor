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

    await page.goto('https://sdat.dat.maryland.gov/RealProperty/Pages/default.aspx', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    const title = await page.title();
    console.log(`[sdat] Page title: "${title}"`);

    // Wait for ANY select to appear in the DOM (covers lazy-rendered dropdowns)
    await page.waitForSelector('select', { timeout: 30000 }).catch(async () => {
      // Last resort: dump page content for diagnosis
      const html = await page.content().catch(() => '');
      console.log('[sdat] No select found. Page HTML snippet:', html.slice(0, 1000));
    });

    const selectCount = await page.locator('select').count();
    console.log(`[sdat] select count: ${selectCount}`);
    if (selectCount === 0) return { error: 'SDAT: no select elements on page — site may have changed structure' };

    // Log all select IDs and option counts
    for (let i = 0; i < selectCount; i++) {
      const sel = page.locator('select').nth(i);
      const id  = await sel.getAttribute('id').catch(() => '');
      const opts = await sel.locator('option').allTextContents().catch(() => []);
      console.log(`[sdat] select[${i}] id="${id}" opts=${opts.length}: ${opts.slice(0, 4).join(' | ')}`);
    }

    // Find the county dropdown — it should have the most options
    let countyIdx = 0;
    let maxOpts = 0;
    for (let i = 0; i < selectCount; i++) {
      const n = await page.locator('select').nth(i).locator('option').count();
      if (n > maxOpts) { maxOpts = n; countyIdx = i; }
    }
    const countySelect = page.locator('select').nth(countyIdx);
    console.log(`[sdat] Using select[${countyIdx}] as county dropdown (${maxOpts} options)`);

    // Try selecting by value, then by partial text
    await countySelect.selectOption({ value: countyCode }).catch(async () => {
      const opts = await countySelect.locator('option').all();
      for (const opt of opts) {
        const text = (await opt.textContent() || '').toUpperCase();
        const val  = await opt.getAttribute('value') || '';
        if (text.includes('BALTIMORE CITY') && countyCode === '03') {
          await countySelect.selectOption({ value: val }); return;
        }
        if (text.includes('BALTIMORE CO') && countyCode === '02') {
          await countySelect.selectOption({ value: val }); return;
        }
        if (text.includes('HARFORD') && countyCode === '13') {
          await countySelect.selectOption({ value: val }); return;
        }
      }
      console.log('[sdat] Could not match county in dropdown');
    });

    // WebForms postback after county selection
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Log visible text inputs
    const inputs = await page.locator('input[type="text"]:visible').all();
    console.log(`[sdat] visible text inputs after county select: ${inputs.length}`);
    for (let i = 0; i < inputs.length; i++) {
      const id = await inputs[i].getAttribute('id').catch(() => '');
      const ph = await inputs[i].getAttribute('placeholder').catch(() => '');
      console.log(`[sdat] input[${i}] id="${id}" placeholder="${ph}"`);
    }

    // Fill street number — try specific selectors first, then by position
    const numInput = await page.locator([
      'input[id*="StreetNumber" i]',
      'input[name*="StreetNumber" i]',
      'input[placeholder*="Street Number" i]',
      'input[placeholder*="House" i]',
    ].join(', ')).first().isVisible().then(v => v
      ? page.locator(['input[id*="StreetNumber" i]','input[name*="StreetNumber" i]','input[placeholder*="Street Number" i]','input[placeholder*="House" i]'].join(', ')).first()
      : inputs[0]
    ).catch(() => inputs[0]);

    const nameInput = await page.locator([
      'input[id*="StreetName" i]',
      'input[name*="StreetName" i]',
      'input[placeholder*="Street Name" i]',
    ].join(', ')).first().isVisible().then(v => v
      ? page.locator(['input[id*="StreetName" i]','input[name*="StreetName" i]','input[placeholder*="Street Name" i]'].join(', ')).first()
      : inputs[1]
    ).catch(() => inputs[1]);

    if (!numInput || !nameInput) return { error: 'SDAT: could not locate address input fields after county selection' };

    await numInput.fill(parsed.number);
    await nameInput.fill(parsed.nameOnly);
    console.log(`[sdat] Filled: number="${parsed.number}" name="${parsed.nameOnly}"`);

    const searchBtn = page.locator('input[type="submit"], button[type="submit"]').first();
    await searchBtn.click();

    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Find first link in results (should be account number or address link)
    const links = await page.locator('table a').all();
    console.log(`[sdat] Result links: ${links.length}`);
    if (links.length === 0) {
      const body = await page.innerText('body').catch(() => '');
      console.log('[sdat] No result links. Body:', body.slice(0, 400));
      return { error: 'SDAT: no results — address not found in county database' };
    }

    await links[0].click();
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const body = await page.innerText('body');
    const ybMatch = body.match(/year\s*built[:\s]+(\d{4})/i);
    const yearBuilt = ybMatch ? Number(ybMatch[1]) : null;
    const acctMatch = body.match(/account\s*(?:number|#|no\.?)[:\s]+([A-Z0-9\-\s]{4,30}?)(?:\n|\r|$)/i);
    const sdatAcct = acctMatch ? acctMatch[1].trim() : null;

    if (!yearBuilt) {
      console.log('[sdat] Detail page body:', body.slice(0, 600));
      return { error: 'SDAT: property detail found but year built not on page' };
    }

    return { year_built: yearBuilt, sdat_acct: sdatAcct };
  } catch (err) {
    return { error: `SDAT scrape failed: ${err.message}` };
  } finally {
    await browser.close();
  }
}

module.exports = { lookupSdat };
