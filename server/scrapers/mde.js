'use strict';

const MDE_COUNTY_CODES = {
  baltimore_city:   'BA',
  baltimore_county: 'BC',
  harford:          'HR',
};

function parseAddress(address) {
  const street = address.split(',')[0].trim();
  const match = street.match(/^(\d+)\s+(.+)$/);
  if (!match) return null;
  const parts = match[2].trim().split(/\s+/);
  const suffixMap = { ST: 'ST', AVE: 'AVE', DR: 'DR', RD: 'RD', LN: 'LN', CT: 'CT', PL: 'PL', WAY: 'WAY', BLVD: 'BLVD', CIR: 'CIR', TER: 'TER', PKWY: 'PKWY' };
  const last = parts[parts.length - 1].toUpperCase();
  const suffix = suffixMap[last] || '';
  const name = suffix ? parts.slice(0, -1).join(' ') : parts.join(' ');
  return { number: match[1], name: name.toUpperCase(), suffix };
}

async function scrapeMdeRegistration(property) {
  const county = MDE_COUNTY_CODES[property.municipality];
  if (!county) return { error: `No MDE county code for: ${property.municipality}` };

  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('https://mdolrr.mde.state.md.us/CustomPages/PublicOLRRSearch.aspx', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Fill address number
    await page.fill('input[id*="HouseNumber"], input[id*="houseNumber"], input[name*="HouseNumber"]', parsed.number).catch(() => {});
    // Fill street name
    await page.fill('input[id*="StreetName"], input[id*="streetName"], input[name*="StreetName"]', parsed.name).catch(() => {});
    // Select county
    await page.selectOption('select[id*="County"], select[name*="County"]', { label: new RegExp(county, 'i') }).catch(async () => {
      await page.selectOption('select[id*="County"], select[name*="County"]', county).catch(() => {});
    });

    // Submit
    await page.click('input[type="submit"], button[type="submit"]').catch(() => {
      return page.press('input[id*="StreetName"]', 'Enter');
    });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    const bodyText = await page.innerText('body');
    if (bodyText.toLowerCase().includes('no records') || bodyText.toLowerCase().includes('no results')) {
      return { registered: false, status: 'not_found' };
    }

    // Parse first result row from table
    const rows = await page.$$('table tr');
    for (const row of rows.slice(1)) {
      const cells = await row.$$eval('td', tds => tds.map(td => td.innerText.trim()));
      if (cells.length >= 3) {
        return {
          registered: true,
          tracking_id: cells[0] || null,
          owner_name: cells[1] || null,
          registration_date: cells[2] || null,
          status: 'registered',
        };
      }
    }

    return { registered: true, status: 'registered' };
  } catch (err) {
    return { error: err.message };
  } finally {
    await browser.close();
  }
}

async function scrapeMdeCertificate(property) {
  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('https://mde-lrca.maryland.gov/Certificates.aspx', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.fill('input[id*="AddressNumber"], input[name*="AddressNumber"]', parsed.number).catch(() => {});
    await page.fill('input[id*="StreetName"], input[name*="StreetName"]', parsed.name).catch(() => {});
    await page.click('input[type="submit"], button[type="submit"]').catch(() => {
      return page.press('input[id*="StreetName"]', 'Enter');
    });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    const bodyText = await page.innerText('body');
    if (bodyText.toLowerCase().includes('no records') || bodyText.toLowerCase().includes('not found')) {
      return { cert_found: false };
    }

    const rows = await page.$$('table tr');
    for (const row of rows.slice(1)) {
      const cells = await row.$$eval('td', tds => tds.map(td => td.innerText.trim()));
      if (cells.length >= 2) {
        return {
          cert_found: true,
          cert_number: cells[0] || null,
          property_address: cells[1] || null,
          county: cells[2] || null,
        };
      }
    }

    return { cert_found: true };
  } catch (err) {
    return { error: err.message };
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeMdeRegistration, scrapeMdeCertificate };
