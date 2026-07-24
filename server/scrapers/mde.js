'use strict';

// County option values for each MDE site (discovered by inspecting live pages)
const OLRR_COUNTY = {
  baltimore_city:   '3',
  baltimore_county: '4',
  harford:          '13',
};

const LRCA_COUNTY = {
  baltimore_city:   '251',
  baltimore_county: '252',
  harford:          '261',
};

function parseAddress(address) {
  const street = address.split(',')[0].trim();
  const match = street.match(/^(\d+)\s+(.+)$/);
  if (!match) return null;
  const parts = match[2].trim().split(/\s+/);
  const suffixes = new Set(['ST', 'AVE', 'DR', 'RD', 'LN', 'CT', 'PL', 'WAY', 'BLVD', 'CIR', 'TER', 'PKWY', 'SQ', 'HWY']);
  const last = parts[parts.length - 1].toUpperCase();
  const suffix = suffixes.has(last) ? last : '';
  const name = suffix ? parts.slice(0, -1).join(' ') : parts.join(' ');
  return { number: match[1], name: name.toUpperCase(), suffix };
}

async function scrapeMdeRegistration(property) {
  const countyVal = OLRR_COUNTY[property.municipality];
  if (!countyVal) return { error: `No MDE county for: ${property.municipality}` };

  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    await page.goto('https://mdolrr.mde.state.md.us/CustomPages/PublicOLRRSearch.aspx', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.fill('#ucpublicSearch1_txtAddressNo', parsed.number);
    await page.fill('#ucpublicSearch1_txtStreetName', parsed.name);
    await page.selectOption('#ucpublicSearch1_ddlCounty', countyVal);
    await page.click('#ucpublicSearch1_btnPublicSearch');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    const bodyText = await page.innerText('body').catch(() => '');
    const lower = bodyText.toLowerCase();
    if (lower.includes('no records') || lower.includes('no results') || lower.includes('0 record')) {
      return { registered: false, status: 'not_found' };
    }

    // Parse results: find data rows where cells[0] is a numeric tracking ID and length === 6
    const rows = await page.$$eval('table tr', trs =>
      trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim()))
    );

    const dataRow = rows.find(cells =>
      cells.length === 6 && /^\d+$/.test(cells[0]) && cells[4].includes('/')
    );

    if (dataRow) {
      return {
        registered: true,
        tracking_id: dataRow[0] || null,
        owner_name: dataRow[1] || null,
        property_address: dataRow[3] || null,
        registration_date: dataRow[4] || null,
        status: dataRow[5].toLowerCase().includes('active') ? 'active' : dataRow[5] || 'registered',
      };
    }

    return { registered: true, status: 'registered' };
  } catch (err) {
    return { error: err.message };
  } finally {
    await browser.close();
  }
}

async function scrapeMdeCertificate(property) {
  const countyVal = LRCA_COUNTY[property.municipality];
  if (!countyVal) return { error: `No MDE LRCA county for: ${property.municipality}` };

  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    await page.goto('https://mde-lrca.maryland.gov/Certificates.aspx', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.fill('#txtHomeAddressNumber', parsed.number);
    await page.fill('#txtHomeStreetName', parsed.name);
    await page.selectOption('#ddlHomeCounty', countyVal);
    await page.click('#btnHomeSearchProperty');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    const bodyText = await page.innerText('body').catch(() => '');
    const lower = bodyText.toLowerCase();
    if (lower.includes('no property records') || lower.includes('not found') || lower.includes('no records')) {
      return { cert_found: false };
    }

    // Columns: Address, Unit, Owner/Manager, County, Property#, Parcel, Inspection Date, Cert#, Cert Status, ...
    const rows = await page.$$eval('table tr', trs =>
      trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim()))
    );

    const dataRow = rows.find(cells =>
      cells.length >= 9 && cells[7] && /^\d+$/.test(cells[7])
    );

    if (dataRow) {
      return {
        cert_found: true,
        property_address: dataRow[0] || null,
        owner_name: dataRow[2] || null,
        county: dataRow[3] || null,
        cert_number: dataRow[7] || null,
        cert_status: dataRow[8] || null,
        inspection_date: dataRow[6] ? dataRow[6].split(' ')[0] : null,
      };
    }

    return { cert_found: true };
  } catch (err) {
    return { error: err.message };
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeMdeRegistration, scrapeMdeCertificate };
