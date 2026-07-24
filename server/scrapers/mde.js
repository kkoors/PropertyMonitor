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

    // Wait until either a data row (numeric tracking ID) or a no-records message appears
    await page.waitForFunction(() => {
      const txt = document.body.innerText.toLowerCase();
      if (txt.includes('no records') || txt.includes('no results')) return true;
      return [...document.querySelectorAll('table tr')].some(tr => {
        const tds = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
        return tds.length === 6 && /^\d+$/.test(tds[0]) && tds[4].includes('/');
      });
    }, { timeout: 20000 }).catch(() => {});

    const rows = await page.$$eval('table tr', trs =>
      trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim()))
    );

    const dataRows = rows.filter(cells =>
      cells.length === 6 && /^\d+$/.test(cells[0]) && cells[4].includes('/')
    );
    console.log(`[mde-olrr] ${parsed.number} ${parsed.name}: ${dataRows.length} registration rows`);

    if (dataRows.length > 0) {
      // Prefer Active rows, then most recent registration date
      const parseUs = d => { const m = (d || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? new Date(`${m[3]}-${m[1]}-${m[2]}`).getTime() : 0; };
      dataRows.sort((a, b) => {
        const aAct = a[5].toLowerCase().includes('active') ? 1 : 0;
        const bAct = b[5].toLowerCase().includes('active') ? 1 : 0;
        if (aAct !== bAct) return bAct - aAct;
        return parseUs(b[4]) - parseUs(a[4]);
      });
      const best = dataRows[0];

      // Owner cell is "Name\nStreet\nCity, State, ZIP" — split name from mailing address
      const ownerLines = (best[1] || '').split('\n').map(s => s.trim()).filter(Boolean);
      const result = {
        registered: true,
        tracking_id: best[0] || null,
        owner_name: ownerLines[0] || null,
        owner_address: ownerLines.slice(1).join(', ') || null,
        property_address: best[3] || null,
        registration_date: best[4] || null,
        status: best[5].toLowerCase().includes('active') ? 'active' : best[5] || 'registered',
      };

      // Drill into Property History (property address is a postback link) for Bank Date + Payment Year
      try {
        const histLink = page.locator('a[id*="lnkPropertyAddress"]').first();
        if (await histLink.isVisible().catch(() => false)) {
          await histLink.click();
          await page.waitForFunction(() =>
            document.body.innerText.includes('Property History') &&
            document.body.innerText.includes('Payment Year'),
            { timeout: 20000 }
          ).catch(() => {});

          // History rows: TrackingID, Owner, PropertyAddr, ConstYear, Status, RemovalDate, StatusCode, RegDate, BankDate, PaymentYear
          const histRows = await page.$$eval('table tr', trs =>
            trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim()))
          );
          const hist = histRows.filter(cells => cells.length >= 10 && /^\d{5,}$/.test(cells[0]) && /^\d{4}$/.test(cells[9]));
          console.log(`[mde-olrr] history: ${hist.length} rows`);

          if (hist.length > 0) {
            // Prefer Active rows; take the max payment year
            const active = hist.filter(c => c[4].toLowerCase().includes('active'));
            const pool = active.length > 0 ? active : hist;
            pool.sort((a, b) => Number(b[9]) - Number(a[9]));
            const h = pool[0];
            const hOwner = (h[1] || '').split('\n').map(s => s.trim()).filter(Boolean);
            result.owner_name = hOwner[0] || result.owner_name;
            result.owner_address = hOwner.slice(1).join(', ') || result.owner_address;
            result.registration_date = h[7] || result.registration_date;
            result.bank_date = h[8] || null;
            result.payment_year = Number(h[9]) || null;
            console.log(`[mde-olrr] latest: bank_date=${result.bank_date} payment_year=${result.payment_year}`);
          }
        }
      } catch (err) {
        console.log(`[mde-olrr] history drill-down failed: ${err.message}`);
      }

      return result;
    }

    const bodyText = await page.innerText('body').catch(() => '');
    const lower = bodyText.toLowerCase();
    if (lower.includes('no records') || lower.includes('no results')) {
      return { registered: false, status: 'not_found' };
    }
    return { error: 'MDE registry: results did not load (timeout)' };
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

    // Wait until either a data row (numeric cert number at col 7) or a no-records message appears
    await page.waitForFunction(() => {
      const txt = document.body.innerText.toLowerCase();
      if (txt.includes('no property records') || txt.includes('no records')) return true;
      return [...document.querySelectorAll('table tr')].some(tr => {
        const tds = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
        return tds.length >= 9 && /^\d+$/.test(tds[7]);
      });
    }, { timeout: 20000 }).catch(() => {});

    // Columns: Address, Unit, Owner/Manager, County, Property#, Parcel, Inspection Date, Cert#, Cert Status, ...
    const rows = await page.$$eval('table tr', trs =>
      trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim()))
    );

    const dataRows = rows.filter(cells =>
      cells.length >= 9 && cells[7] && /^\d+$/.test(cells[7])
    );
    console.log(`[mde-lrca] ${parsed.number} ${parsed.name}: ${dataRows.length} certificate rows`);

    if (dataRows.length > 0) {
      const parseUs = d => { const m = (d || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? new Date(`${m[3]}-${m[1]}-${m[2]}`).getTime() : 0; };
      dataRows.sort((a, b) => parseUs(b[6]) - parseUs(a[6]));

      // Group by unit (col 1) and keep the latest inspection per unit
      const byUnit = new Map();
      for (const row of dataRows) {
        const unit = (row[1] || '').trim();
        if (!byUnit.has(unit)) byUnit.set(unit, row); // rows are sorted newest-first
      }
      const units = [...byUnit.entries()].map(([unit, r]) => ({
        unit,
        cert_number: r[7] || null,
        cert_status: r[8] || null,
        inspection_date: r[6] ? r[6].split(' ')[0] : null,
      }));
      console.log(`[mde-lrca] ${units.length} unit(s): ${units.map(u => `${u.unit || '(whole)'}=${u.cert_status}`).join(', ')}`);

      const best = dataRows[0];
      return {
        cert_found: true,
        property_address: best[0] || null,
        owner_name: best[2] || null,
        county: best[3] || null,
        cert_number: best[7] || null,
        cert_status: best[8] || null,
        inspection_date: best[6] ? best[6].split(' ')[0] : null,
        units,
      };
    }

    const bodyText = await page.innerText('body').catch(() => '');
    const lower = bodyText.toLowerCase();
    if (lower.includes('no property records') || lower.includes('not found') || lower.includes('no records')) {
      return { cert_found: false };
    }
    return { error: 'MDE certificates: results did not load (timeout)' };
  } catch (err) {
    return { error: err.message };
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeMdeRegistration, scrapeMdeCertificate };
