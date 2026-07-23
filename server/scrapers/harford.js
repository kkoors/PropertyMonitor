'use strict';
/**
 * Harford County water bill scraper
 * Portal: https://hcgweb01.harfordcountymd.gov/billpay
 * No login required — public self-service portal
 */

const BASE = 'https://hcgweb01.harfordcountymd.gov/billpay';

async function scrapeHarford(property) {
  const result = { property_id: property.id, bills: [], error: null, account_number: null };

  try {
    let searchHtml;
    if (property.account_number) {
      searchHtml = await searchById(property.account_number);
    } else {
      searchHtml = await searchByAddress(property.address);
    }

    // Find the Account/Detail link
    let detailPath = extractDetailLink(searchHtml);
    if (!detailPath) {
      // If ID search failed, try address fallback
      if (property.account_number) {
        const fallback = await searchByAddress(property.address);
        detailPath = extractDetailLink(fallback);
        if (!detailPath) {
          result.error = 'No account found for this property on Harford County portal.';
          return result;
        }
        searchHtml = fallback;
      } else {
        result.error = 'No account found for this property on Harford County portal.';
        return result;
      }
    }

    const detailResp = await fetch(`${BASE}${detailPath.replace(/^\/billpay/, '')}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const detailHtml = await detailResp.text();
    const text = stripTags(detailHtml).replace(/\s+/g, ' ');

    // Locate the water/sewer section
    const wsIdx = text.search(/Water\s+Sewer\s+Usage/i);
    if (wsIdx === -1) {
      result.error = 'No Water Sewer Usage section found on account detail page.';
      return result;
    }
    const wsText = text.slice(wsIdx, wsIdx + 600);

    // Amount due from section header: "Water Sewer Usage - Balance Due: $200.26"
    // When balance is $0 the portal omits the amount entirely — default to 0
    const amountMatch = wsText.match(/Balance\s+Due:\s*\$?([\d,]+\.?\d*)/i);
    const amount_due = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : 0;

    // WaterSewerId: 8 digits dash 2 digits  e.g. 01012666-00
    const idMatch = wsText.match(/\b(\d{8}-\d{2})\b/) || text.match(/\b(\d{8}-\d{2})\b/);
    if (idMatch) result.account_number = idMatch[1];

    // Dates
    const billingDate   = normDate(wsText.match(/Billing\s+Date:\s*([\d\/]+)/i)?.[1]);
    const dueDate       = normDate(wsText.match(/Due\s+Date:\s*([\d\/]+)/i)?.[1]);
    const curBalance    = wsText.match(/Current\s+Balance:\s*\$?([\d,]+\.?\d*)/i);
    const presentRead   = normDate(wsText.match(/Present\s+Read\s+Date:\s*([\d\/]+)/i)?.[1]);
    const previousRead  = normDate(wsText.match(/Previous\s+Read\s+Date:\s*([\d\/]+)/i)?.[1]);

    result.bills.push({
      property_id:     property.id,
      amount_due,
      bill_date:       billingDate || new Date().toISOString().split('T')[0],
      due_date:        dueDate || null,
      current_balance: curBalance ? parseFloat(curBalance[1].replace(/,/g, '')) : null,
      period_start:    previousRead || null,
      period_end:      presentRead || null,
      raw_data:        wsText,
    });
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

async function searchById(id) {
  const url = `${BASE}/Search/ByWaterSewerId?WaterSewerId=${encodeURIComponent(id)}`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  return resp.text();
}

async function searchByAddress(address) {
  // Strip everything from the first comma onward (city, state, zip)
  let street = address.split(',')[0].trim();
  // Strip trailing street type suffix — portal matches better without it
  street = street.replace(/\s+(AVE|AVENUE|BLVD|BOULEVARD|CIR|CIRCLE|CT|COURT|DR|DRIVE|LN|LANE|PKWY|PARKWAY|PL|PLACE|RD|ROAD|SQ|SQUARE|ST|STREET|TER|TERRACE|TRL|TRAIL|WAY)\.?$/i, '').trim();

  // Try variants: original, then directional expansions/contractions, then SAINT↔ST
  const variants = addressVariants(street);
  for (const variant of variants) {
    const url = `${BASE}/Search/ByAddress?Address=${encodeURIComponent(variant)}`;
    const html = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text());
    if (extractDetailLink(html)) return html;
  }
  // Return last attempt (will trigger no-results handling)
  const url = `${BASE}/Search/ByAddress?Address=${encodeURIComponent(variants[0])}`;
  return fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text());
}

const DIR_EXPAND = { N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST', NE: 'NORTHEAST', NW: 'NORTHWEST', SE: 'SOUTHEAST', SW: 'SOUTHWEST' };
const DIR_CONTRACT = Object.fromEntries(Object.entries(DIR_EXPAND).map(([k, v]) => [v, k]));

function addressVariants(street) {
  const variants = [street];

  // Directional after house number: "20 N FOREST" ↔ "20 NORTH FOREST"
  const dirAbbrevMatch = street.match(/^(\d+\s+)(N|S|E|W|NE|NW|SE|SW)\s+(.+)$/i);
  if (dirAbbrevMatch) {
    const expanded = `${dirAbbrevMatch[1]}${DIR_EXPAND[dirAbbrevMatch[2].toUpperCase()]} ${dirAbbrevMatch[3]}`;
    variants.push(expanded);
  }
  const dirFullMatch = street.match(/^(\d+\s+)(NORTH|SOUTH|EAST|WEST|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST)\s+(.+)$/i);
  if (dirFullMatch) {
    const contracted = `${dirFullMatch[1]}${DIR_CONTRACT[dirFullMatch[2].toUpperCase()]} ${dirFullMatch[3]}`;
    variants.push(contracted);
  }

  // SAINT ↔ ST prefix in street name
  const saintMatch = street.match(/\bSAINT\s+/i);
  const stMatch = street.match(/\bST\s+/i);
  if (saintMatch) variants.push(street.replace(/\bSAINT\s+/i, 'ST '));
  if (stMatch)    variants.push(street.replace(/\bST\s+/i, 'SAINT '));

  return [...new Set(variants)];
}

function extractDetailLink(html) {
  const m = html.match(/href="(\/billpay\/Account\/Detail\?[^"]+)"/i);
  return m ? m[1] : null;
}

function normDate(str) {
  if (!str) return null;
  const m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  try { return new Date(str).toISOString().split('T')[0]; } catch { return null; }
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/&bull;/g, '•')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ');
}

module.exports = { scrapeHarford };
