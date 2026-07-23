'use strict';
/**
 * Baltimore City / Baltimore County water bill scraper
 * Portal: https://pay.baltimorecity.gov/water
 *
 * Flow:
 *   1. If we have an account number → POST /water/Home/_getInfoByAccountNumberTemp
 *   2. If we only have an address   → POST /water/_getInfoByServiceAddress to get account number, then step 1
 *   Both return { redirectToUrl } → navigate to /water/bill and parse the page text.
 */
const path = require('path');

const ORIGIN = 'https://pay.baltimorecity.gov';
const BILLS_DIR = path.join(__dirname, '..', '..', 'bills');

async function scrapeBaltimore(property, browser) {
  const page = await browser.newPage();
  const result = { property_id: property.id, bills: [], error: null, account_number: null };

  try {
    // Load the portal to establish session + get CSRF token
    await page.goto(`${ORIGIN}/water`, { waitUntil: 'networkidle', timeout: 30000 });

    let accountNumber = property.account_number;

    // If no account number stored, look it up by address first
    if (!accountNumber) {
      accountNumber = await lookupAccountByAddress(page, property.address);
      if (!accountNumber) throw new Error('Could not find account number for address: ' + property.address);
      result.account_number = accountNumber; // caller will store this
    }

    // Get redirect URL for this account
    const redirectUrl = await getRedirectUrl(page, accountNumber);
    if (!redirectUrl) throw new Error('No redirect URL returned for account ' + accountNumber);

    // Navigate to bill details page
    await page.goto(ORIGIN + redirectUrl, { waitUntil: 'networkidle', timeout: 30000 });
    const pageText = await page.evaluate(() => document.body.innerText);

    const bill = parseBillText(pageText, property.id, accountNumber);
    if (bill) {
      result.account_number = bill.account_number || accountNumber;
      await downloadPdf(page, property, bill);
      result.bills.push(bill);
    } else {
      throw new Error('Could not parse bill data from page');
    }
  } catch (err) {
    result.error = err.message;
  } finally {
    await page.close();
  }

  return result;
}

async function lookupAccountByAddress(page, address) {
  // Normalize address to match portal expectations
  const normalized = address
    .replace(/\bWest\b/gi, 'W').replace(/\bEast\b/gi, 'E')
    .replace(/\bNorth\b/gi, 'N').replace(/\bSouth\b/gi, 'S')
    .replace(/\bStreet\b/gi, 'St').replace(/\bAvenue\b/gi, 'Ave')
    .replace(/\bDrive\b/gi, 'Dr').replace(/\bRoad\b/gi, 'Rd')
    .replace(/\bBoulevard\b/gi, 'Blvd').replace(/\bLane\b/gi, 'Ln')
    .replace(/,.*$/, '').trim();

  const html = await page.evaluate(async (addr) => {
    const csrf = document.querySelector('input[name=__RequestVerificationToken]')?.value;
    const res = await fetch(window.location.origin + '/water/_getInfoByServiceAddress', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'RequestVerificationToken': csrf,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: 'ServiceAddress=' + encodeURIComponent(addr),
    });
    return res.text();
  }, normalized);

  // Extract the first account number from the response HTML
  const match = html.match(/value="(\d{11})"/);
  return match?.[1] || null;
}

async function getRedirectUrl(page, accountNumber) {
  const data = await page.evaluate(async (acct) => {
    const csrf = document.querySelector('input[name=__RequestVerificationToken]')?.value;
    const res = await fetch(window.location.origin + '/water/Home/_getInfoByAccountNumberTemp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'RequestVerificationToken': csrf,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: 'accountNumber=' + encodeURIComponent(acct),
    });
    return res.json();
  }, accountNumber);

  return data?.redirectToUrl || null;
}

function parseBillText(text, propertyId, accountNumber) {
  // Parse the exact text structure returned by /water/bill
  // e.g. "Account Number 11000357782"
  //      "Current Bill Date 05/26/2026"
  //      "Penalty Date 06/15/2026"
  //      "Current Bill Amount $ 28.00"
  //      "Previous Balance $ 14.00"
  //      "Last Pay Date 04/25/2026"
  //      "Last Pay Amount $ -14.00"

  const g = (pattern) => text.match(pattern)?.[1]?.trim() || null;
  const money = (pattern) => {
    const raw = g(pattern);
    return raw ? parseFloat(raw.replace(/[$,\s]/g, '')) : null;
  };

  const parsedAccount  = g(/Account Number\s+(\d+)/i) || accountNumber;
  const billDate       = g(/Current Bill Date\s+([\d\/]+)/i);
  const dueDate        = g(/Penalty Date\s+([\d\/]+)/i);
  const currentAmount  = money(/Current Bill Amount\s+\$?\s*([\d,.\-]+)/i);
  const prevBalance    = money(/Previous Balance\s+\$?\s*([\d,.\-]+)/i);
  const currentBalance = money(/Current Balance\s+\$?\s*([\d,.\-]+)/i);
  const lastPayDate    = g(/Last Pay Date\s+([\d\/]+)/i);
  const lastPayAmount  = money(/Last Pay Amount\s+\$?\s*([\d,.\-]+)/i);

  if (!billDate && !currentAmount) return null;

  return {
    property_id:     propertyId,
    account_number:  parsedAccount,
    bill_date:       billDate,
    due_date:        dueDate,
    amount_due:      currentAmount,
    balance_forward: prevBalance,
    current_balance: currentBalance,
    last_pay_date:   lastPayDate,
    last_pay_amount: lastPayAmount,
    period_start:    null,
    period_end:      null,
    usage_gallons:   null,
    raw_data:        text.slice(0, 4000),
  };
}

async function downloadPdf(page, property, bill) {
  try {
    const pdfLink = await page.$('a[href*=".pdf" i], a:has-text("PDF"), a:has-text("Download"), button:has-text("Print")');
    if (!pdfLink) return;
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      pdfLink.click(),
    ]);
    const filename = `baltimore_${property.id}_${bill.bill_date?.replace(/\//g, '-')}.pdf`;
    await download.saveAs(path.join(BILLS_DIR, filename));
    bill.pdf_path = filename;
  } catch { /* best-effort */ }
}

module.exports = { scrapeBaltimore };
