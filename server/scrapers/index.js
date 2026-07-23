'use strict';
const { chromium } = require('playwright');
const { decrypt } = require('../db');
const { scrapeBaltimore } = require('./baltimore');
const { scrapeHarford } = require('./harford');

function makeRunScrapers(db) {
  return async function runAllScrapers(triggeredBy = 'scheduler') {
    const run = db.prepare(`INSERT INTO scrape_runs (triggered_by) VALUES (?)`).run(triggeredBy);
    const runId = run.lastInsertRowid;

    const properties = db.prepare(`SELECT * FROM properties WHERE active = 1 AND private_ws = 0`).all();
    let billsFound = 0, errors = 0;
    const log = [];

    const browser = await chromium.launch({ headless: true });

    try {
      for (const property of properties) {
        log.push(`[${new Date().toISOString()}] Checking: ${property.name} (${property.municipality})`);

        let result;
        try {
          if (property.municipality === 'baltimore_city' || property.municipality === 'baltimore_county') {
            result = await scrapeBaltimore(property, browser);
          } else if (property.municipality === 'harford') {
            result = await scrapeHarford(property);
          } else {
            log.push(`  SKIP: unknown municipality`);
            continue;
          }

          if (result.error) {
            log.push(`  ERROR: ${result.error}`);
            errors++;
          } else {
            // Save discovered account number back to property
            if (result.account_number && !property.account_number) {
              db.prepare(`UPDATE properties SET account_number = ? WHERE id = ?`)
                .run(result.account_number, property.id);
              log.push(`  Stored account number: ${result.account_number}`);
            }
            for (const bill of result.bills) {
              if (insertBillIfNew(db, bill, runId)) {
                billsFound++;
                log.push(`  NEW BILL: $${bill.amount_due} due ${bill.due_date || '?'}`);
              } else {
                log.push(`  Already stored: $${bill.amount_due}`);
              }
            }
          }
        } catch (err) {
          log.push(`  FATAL: ${err.message}`);
          errors++;
        }
      }
    } finally {
      await browser.close();
    }

    db.prepare(`
      UPDATE scrape_runs
      SET finished_at = datetime('now'), properties_checked = ?, bills_found = ?, errors = ?, log = ?
      WHERE id = ?
    `).run(properties.length, billsFound, errors, log.join('\n'), runId);

    return { runId, propertiesChecked: properties.length, billsFound, errors };
  };
}

function getCredentials(db, propertyId, portal) {
  const row = db.prepare(`SELECT * FROM credentials WHERE property_id = ? AND portal = ?`).get(propertyId, portal);
  if (!row) return null;
  return { username: decrypt(row.username_enc, row.iv), password: decrypt(row.password_enc, row.iv) };
}

function insertBillIfNew(db, bill, runId) {
  // Check for duplicate first (sql.js doesn't return changes reliably on INSERT OR IGNORE)
  const existing = db.prepare(
    `SELECT id, period_start, period_end FROM bills WHERE property_id = ? AND bill_date = ? AND amount_due = ?`
  ).get(bill.property_id, bill.bill_date, bill.amount_due);
  if (existing) {
    // Update period dates if we now have them and they weren't stored before
    if ((bill.period_start && !existing.period_start) || (bill.period_end && !existing.period_end)) {
      db.prepare(`UPDATE bills SET period_start = COALESCE(period_start, ?), period_end = COALESCE(period_end, ?) WHERE id = ?`)
        .run(bill.period_start || null, bill.period_end || null, existing.id);
    }
    return false;
  }

  const status = (bill.amount_due != null && bill.amount_due <= 0) ? 'paid' : 'new';

  db.prepare(`
    INSERT INTO bills
      (property_id, account_number, bill_date, due_date, amount_due, balance_forward,
       current_balance, last_pay_date, last_pay_amount,
       period_start, period_end, usage_gallons, pdf_path, raw_data, scrape_run_id, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    bill.property_id, bill.account_number || null, bill.bill_date || null, bill.due_date || null,
    bill.amount_due ?? null, bill.balance_forward ?? null,
    bill.current_balance ?? null, bill.last_pay_date || null, bill.last_pay_amount ?? null,
    bill.period_start || null, bill.period_end || null,
    bill.usage_gallons ?? null, bill.pdf_path || null,
    bill.raw_data || null, runId, status
  );
  return true;
}

function makeRunOne(db) {
  const runAllScrapers = makeRunScrapers(db);
  return async function runOneProperty(propertyId, triggeredBy = 'manual') {
    const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(propertyId);
    if (!property) throw new Error(`Property ${propertyId} not found`);

    // Temporarily filter to just this property by monkey-patching the scrapers call
    const run = db.prepare(`INSERT INTO scrape_runs (triggered_by) VALUES (?)`).run(triggeredBy);
    const runId = run.lastInsertRowid;
    const log = [`[${new Date().toISOString()}] Checking: ${property.name} (${property.municipality})`];
    let billsFound = 0, errors = 0;

    const needsBrowser = property.municipality === 'baltimore_city' || property.municipality === 'baltimore_county';
    const browser = needsBrowser ? await require('playwright').chromium.launch({ headless: true }) : null;
    try {
      let result;
      if (needsBrowser) {
        result = await require('./baltimore').scrapeBaltimore(property, browser);
      } else if (property.municipality === 'harford') {
        result = await require('./harford').scrapeHarford(property);
      } else {
        throw new Error(`Unknown municipality: ${property.municipality}`);
      }

      if (result.error) {
        log.push(`  ERROR: ${result.error}`);
        errors++;
      } else {
        if (result.account_number && !property.account_number) {
          db.prepare(`UPDATE properties SET account_number = ? WHERE id = ?`)
            .run(result.account_number, property.id);
          log.push(`  Stored account number: ${result.account_number}`);
        }
        for (const bill of result.bills) {
          if (insertBillIfNew(db, bill, runId)) {
            billsFound++;
            log.push(`  NEW BILL: $${bill.amount_due} due ${bill.due_date || '?'}`);
          } else {
            log.push(`  Already stored: $${bill.amount_due}`);
          }
        }
      }
    } finally {
      if (browser) await browser.close();
    }

    db.prepare(`
      UPDATE scrape_runs
      SET finished_at = datetime('now'), properties_checked = 1, bills_found = ?, errors = ?, log = ?
      WHERE id = ?
    `).run(billsFound, errors, log.join('\n'), runId);

    return { runId, billsFound, errors, log };
  };
}

module.exports = { makeRunScrapers, makeRunOne };
