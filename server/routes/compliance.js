'use strict';
const { Router } = require('express');
const { lookupSdat, lookupSdatMailing } = require('../scrapers/sdat');
const { scrapeRentalLicenseBaltimoreCounty } = require('../scrapers/rentalLicenseBaltimoreCounty');
const { scrapeRentalLicenseBaltimoreCity } = require('../scrapers/rentalLicenseBaltimoreCity');
const { scrapeMdeRegistration, scrapeMdeCertificate } = require('../scrapers/mde');
const { harvestOpenGovLocations, keyFromAddress, resolveLocationIdByAddress, lookupYearBuiltByAddress } = require('../scrapers/opengovLocations');

const DAYS = ms => Math.round(ms / 86400000);

// Express 4 does not catch rejections from async handlers, so a scraper that
// throws (a timed-out fetch, say) would take the whole server down mid-run.
const aw = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function normalizeUsDate(val) {
  if (!val) return null;
  const m = val.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return val;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function billStatus(property) {
  if (property.private_ws) return { status: 'na', label: 'Private W/S' };
  if (!property.latest_bill_date) return { status: 'unknown', label: 'No bills' };
  const amount = Number(property.latest_amount) || 0;
  const dueDate = property.latest_due_date;
  if (dueDate && new Date(dueDate) < new Date() && amount > 0) return { status: 'red', label: `Overdue $${amount.toFixed(2)}` };
  if (property.new_bill_count > 0) return { status: 'yellow', label: `${property.new_bill_count} new bill(s)` };
  return { status: 'green', label: 'Current' };
}

function rentalLicenseStatus(licenses, municipality) {
  const relevant = licenses.filter(l => l.municipality === municipality);
  if (relevant.length === 0) return { status: 'red', label: 'No license on file' };

  // Multi-unit: every unit needs an active license
  if (relevant.length > 1) {
    const now = new Date();
    const bad = relevant.filter(l => l.status !== 'active' || (l.exp_date && new Date(l.exp_date) < now));
    if (bad.length > 0) return { status: 'red', label: `Units lapsed: ${bad.map(l => l.unit || '?').join(', ')} (${relevant.length - bad.length}/${relevant.length} OK)` };
    const soonest = relevant.filter(l => l.exp_date).sort((a, b) => a.exp_date.localeCompare(b.exp_date))[0];
    if (soonest) {
      const daysLeft = DAYS(new Date(soonest.exp_date) - now);
      if (daysLeft < 60) return { status: 'yellow', label: `Unit ${soonest.unit || '?'} expires in ${daysLeft}d` };
      return { status: 'green', label: `${relevant.length}/${relevant.length} units licensed` };
    }
    return { status: 'green', label: `${relevant.length}/${relevant.length} units licensed` };
  }

  const active = relevant.find(l => l.status === 'active');
  if (!active) {
    const expired = relevant.find(l => l.status === 'expired');
    if (expired) return { status: 'red', label: `Expired ${expired.exp_date || ''}` };
    const st = relevant[0].status;
    if (st === 'not_found') return { status: 'red', label: 'Not registered' };
    if (st === 'not_licensed') return { status: 'red', label: 'Registered, not licensed' };
    return { status: 'yellow', label: st };
  }
  if (active.exp_date) {
    const daysLeft = DAYS(new Date(active.exp_date) - new Date());
    if (daysLeft < 0) return { status: 'red', label: `Expired ${active.exp_date}` };
    if (daysLeft < 60) return { status: 'yellow', label: `Expires in ${daysLeft}d` };
  }
  return { status: 'green', label: active.exp_date ? `Expires ${active.exp_date}` : 'Active' };
}

// Loose normalized comparison for names/addresses ("Sheila M Veney" vs "SHEILA VENEY")
function looseMatch(a, b) {
  if (!a || !b) return null; // can't compare
  const norm = s => s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return null;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Token overlap: consider a match if most tokens of the shorter string appear in the longer
  const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  const hits = [...small].filter(t => big.has(t)).length;
  return hits >= Math.max(1, small.size - 1);
}

function parseHiddenUnits(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function registrationStatus(registrations) {
  if (registrations.length === 0) return { status: 'unknown', label: 'Not checked' };
  const r = registrations[0];
  if (r.status === 'active') {
    if (r.exp_date) {
      const daysLeft = DAYS(new Date(r.exp_date) - new Date());
      if (daysLeft < 60) return { status: 'yellow', label: `Reg expires in ${daysLeft}d` };
      return { status: 'green', label: `Registered thru ${r.exp_date}` };
    }
    return { status: 'green', label: 'Registered' };
  }
  if (r.status === 'expired') return { status: 'red', label: `Reg expired ${r.exp_date || ''}` };
  if (r.status === 'not_found') return { status: 'red', label: 'No registration found' };
  return { status: 'yellow', label: r.status };
}

// Shared gating for both lead columns — commercial/not-monitored/post-1978/lead-free
function leadGate(property) {
  if (property.commercial) return { status: 'na', label: 'Commercial' };
  if (property.lead_not_monitored) return { status: 'na', label: 'Not monitored' };
  const yearBuilt = property.year_built;
  if (yearBuilt && yearBuilt >= 1978) return { status: 'na', label: 'Post-1978' };
  if (!yearBuilt) return { status: 'unknown', label: 'Year built unknown' };

  if (property.lead_free) {
    const exp = property.lead_free_cert_exp_date;
    if (!exp) return { status: 'green', label: 'Lead-free certified' };
    const daysLeft = DAYS(new Date(exp) - new Date());
    if (daysLeft < 0) return { status: 'red', label: `Lead-free cert expired ${exp}` };
    if (daysLeft < 60) return { status: 'yellow', label: `Lead-free cert exp in ${daysLeft}d` };
    return { status: 'green', label: `Lead-free cert exp ${exp}` };
  }
  return null; // no gate — evaluate normally
}

// MDE lead REGISTRATION: annual fee. Shows the year paid; must cover current year.
function leadRegistrationStatus(property, leadRecords) {
  const gate = leadGate(property);
  if (gate) return gate;

  if (leadRecords.length === 0) return { status: 'unknown', label: 'Not checked' };
  const latest = leadRecords[0];
  const registered = latest.registration_status && latest.registration_status !== 'not_found';
  if (!registered) return { status: 'red', label: 'Not registered' };

  // Registration must be under the CURRENT owner, at the owner's mailing address on file
  if (looseMatch(property.owner_name, latest.owner_name) === false) {
    return { status: 'red', label: `Registered to prior owner (${latest.owner_name})` };
  }
  if (looseMatch(property.owner_address, latest.owner_address) === false) {
    return { status: 'red', label: `Owner address mismatch (${latest.owner_address})` };
  }

  const currentYear = new Date().getFullYear();
  const payYear = latest.payment_year ? Number(latest.payment_year) : null;
  if (payYear !== null) {
    if (payYear >= currentYear) return { status: 'green', label: String(payYear) };
    const lastRenewed = latest.bank_date || latest.registration_date;
    return { status: 'red', label: lastRenewed ? `${payYear} — last renewed ${lastRenewed}` : String(payYear) };
  }
  // No payment-year history — fall back to registration date year
  const regYear = latest.registration_date ? new Date(latest.registration_date).getFullYear() : null;
  if (regYear === currentYear) return { status: 'green', label: String(regYear) };
  return { status: 'yellow', label: `Registered ${latest.registration_date || ''} — payment year unknown` };
}

// Lead CERTIFICATE: inspection required at every tenant turnover — independent of registration.
function leadCertStatus(property, leadRecords, leadUnits = []) {
  const gate = leadGate(property);
  if (gate) return gate;

  // Multifamily: judge per-unit certs
  if (property.multifamily) {
    const total = leadUnits.length;
    if (total === 0) return { status: 'yellow', label: 'No unit certs on file' };
    const passed = leadUnits.filter(u => (u.cert_status || '').toUpperCase().includes('PASS')).length;
    const failed = leadUnits.filter(u => (u.cert_status || '').toUpperCase().includes('FAIL'));
    if (failed.length > 0) return { status: 'red', label: `Unit ${failed.map(u => u.unit).join(', ')} FAILED (${passed}/${total} passed)` };
    if (passed === total) return { status: 'green', label: `${passed}/${total} units passed` };
    return { status: 'yellow', label: `${passed}/${total} units passed` };
  }

  if (leadRecords.length === 0) return { status: 'unknown', label: 'Not checked' };
  const latest = leadRecords[0];
  if (!latest.cert_number) return { status: 'yellow', label: 'No inspection cert on file' };
  const passed = (latest.cert_status || '').toUpperCase().includes('PASS');
  const when = latest.inspection_date ? ` ${latest.inspection_date}` : '';
  if (passed) return { status: 'green', label: `${latest.cert_number} passed${when}` };
  return { status: 'red', label: `${latest.cert_number} ${latest.cert_status || 'FAILED'}${when}` };
}

module.exports = function makeComplianceRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const properties = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM bills b WHERE b.property_id = p.id AND b.status = 'new') as new_bill_count,
        (SELECT b.amount_due FROM bills b WHERE b.property_id = p.id ORDER BY b.created_at DESC LIMIT 1) as latest_amount,
        (SELECT b.bill_date  FROM bills b WHERE b.property_id = p.id ORDER BY b.created_at DESC LIMIT 1) as latest_bill_date,
        (SELECT b.due_date   FROM bills b WHERE b.property_id = p.id ORDER BY b.created_at DESC LIMIT 1) as latest_due_date
      FROM properties p WHERE p.active = 1 ORDER BY p.name
    `).all();

    const result = properties.map(p => {
      const allLicenses = db.prepare(`SELECT id, municipality, license_type, unit, license_number, status, issue_date, exp_date, scraped_at, notes, (confirmation_letter IS NOT NULL) as has_letter FROM rental_licenses WHERE property_id = ?`).all(p.id);
      const licenses = allLicenses.filter(l => l.license_type === 'rental_license');
      const registrations = allLicenses.filter(l => l.license_type === 'registration');
      const allLead = db.prepare(`SELECT * FROM lead_records WHERE property_id = ? ORDER BY inspection_date DESC`).all(p.id);
      const leadRecords = allLead.filter(r => r.source !== 'mde-unit');
      const hiddenUnits = parseHiddenUnits(p.hidden_lead_units);
      const leadUnits = allLead.filter(r => r.source === 'mde-unit' && !hiddenUnits.includes(r.unit || ''));

      const needsRentalLicense = !p.commercial && !p.license_not_monitored && (p.municipality === 'baltimore_city' || p.municipality === 'baltimore_county');

      return {
        id: p.id,
        name: p.name,
        address: p.address,
        owner_name: p.owner_name || null,
        municipality: p.municipality,
        year_built: p.year_built,
        lead_free: p.lead_free,
        private_ws: p.private_ws,
        water: billStatus(p),
        rental_license: needsRentalLicense ? rentalLicenseStatus(licenses, p.municipality) : { status: 'na', label: p.commercial ? 'Commercial' : (p.license_not_monitored ? 'Not monitored' : 'N/A') },
        city_registration: (needsRentalLicense && p.municipality === 'baltimore_city')
          ? registrationStatus(registrations)
          : { status: 'na', label: 'N/A' },
        rental_license_has_letter: licenses.some(l => l.municipality === p.municipality && l.has_letter),
        lead_registration: leadRegistrationStatus(p, leadRecords),
        lead_cert: leadCertStatus(p, leadRecords, leadUnits),
      };
    });

    res.json(result);
  });

  // Year built, trying every source we have: the jurisdiction's parcel layer,
  // then the statewide layer, then DHCD (which knows condo units the parcel
  // layers miss).
  async function findYearBuilt(property) {
    const result = await lookupSdat(property);
    if (result && result.year_built) return result;

    if (property.municipality === 'baltimore_city') {
      try {
        const og = await lookupYearBuiltByAddress(property.address, property.opengov_location_id);
        if (og && og.year_built) {
          console.log(`[year-built] ${property.name}: ${og.year_built} from DHCD location ${og.locationID}`);
          return { year_built: og.year_built, sdat_acct: result && result.sdat_acct, source: 'dhcd' };
        }
      } catch (err) {
        console.log(`[year-built] DHCD lookup failed for ${property.name}: ${err.message}`);
      }
    }
    return result;
  }

  function saveYearBuilt(property, result) {
    if (!result || !result.year_built) return false;
    db.prepare(`UPDATE properties SET year_built = ?, sdat_acct = COALESCE(?, sdat_acct) WHERE id = ?`)
      .run(result.year_built, result.sdat_acct || null, property.id);
    return true;
  }

  // Trigger SDAT lookup for a property
  router.post('/sdat/:propertyId', aw(async (req, res) => {
    const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.propertyId);
    if (!property) return res.status(404).json({ error: 'Not found' });

    const result = await findYearBuilt(property);
    if (result.error && !result.year_built) return res.status(422).json({ error: result.error });
    saveYearBuilt(property, result);
    res.json(result);
  }));

  // Bulk: fill in every missing year built (?force=1 re-checks them all)
  router.post('/year-built-all', aw(async (req, res) => {
    const force = req.query.force === '1';
    const targets = db.prepare(
      `SELECT * FROM properties WHERE active = 1 ${force ? '' : 'AND (year_built IS NULL OR year_built = 0)'} ORDER BY name`
    ).all();

    const filled = [], failed = [];
    for (const p of targets) {
      try {
        const r = await findYearBuilt(p);
        if (saveYearBuilt(p, r)) filled.push({ id: p.id, name: p.name, year_built: r.year_built });
        else failed.push({ id: p.id, name: p.name, error: (r && r.error) || 'not found in any source' });
      } catch (err) {
        failed.push({ id: p.id, name: p.name, error: err.message });
      }
    }
    console.log(`[year-built] filled ${filled.length}, still missing ${failed.length} of ${targets.length}`);
    res.json({ checked: targets.length, filled, failed });
  }));

  // Helper to upsert a rental license/registration result (including optional confirmation_letter blob)
  function upsertLicense(propertyId, municipality, result, licenseType = 'rental_license') {
    const letter = result.confirmation_letter || null;
    const existing = db.prepare(`SELECT id FROM rental_licenses WHERE property_id = ? AND municipality = ? AND license_type = ?`).get(propertyId, municipality, licenseType);
    if (existing) {
      const stmt = letter
        ? db.prepare(`UPDATE rental_licenses SET license_number=?, status=?, issue_date=?, exp_date=?, notes=?, confirmation_letter=?, scraped_at=datetime('now') WHERE id=?`)
        : db.prepare(`UPDATE rental_licenses SET license_number=?, status=?, issue_date=?, exp_date=?, notes=?, scraped_at=datetime('now') WHERE id=?`);
      letter
        ? stmt.run(result.license_number, result.status, result.issue_date || null, result.exp_date || null, result.notes || null, letter, existing.id)
        : stmt.run(result.license_number, result.status, result.issue_date || null, result.exp_date || null, result.notes || null, existing.id);
    } else {
      db.prepare(`INSERT INTO rental_licenses (property_id, municipality, license_type, license_number, status, issue_date, exp_date, notes, confirmation_letter, scraped_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`)
        .run(propertyId, municipality, licenseType, result.license_number, result.status, result.issue_date || null, result.exp_date || null, result.notes || null, letter);
    }
  }

  // City scrapes return { license, registration } — store each under its own type
  function storeCityResult(propertyId, result) {
    if (result.license) upsertLicense(propertyId, 'baltimore_city', result.license, 'rental_license');
    else upsertLicense(propertyId, 'baltimore_city', { license_number: result.license_number, status: result.status, issue_date: result.issue_date, exp_date: result.exp_date }, 'rental_license');
    // Always write a registration row. Without this a property with no
    // registration on file keeps reading "never checked" after every check,
    // which is indistinguishable from never having run one.
    upsertLicense(
      propertyId,
      'baltimore_city',
      result.registration || { license_number: null, status: 'not_found', issue_date: null, exp_date: null },
      'registration',
    );
  }

  // County scrapes return { licenses: [per-unit rows] } — replace all unit rows
  function storeCountyResult(propertyId, result) {
    if (Array.isArray(result.licenses) && result.licenses.length > 0) {
      // Rows are replaced wholesale, so carry a previously downloaded
      // certificate across — a routine check no longer fetches one.
      const existing = db.prepare(
        `SELECT confirmation_letter FROM rental_licenses
          WHERE property_id = ? AND municipality = 'baltimore_county'
            AND license_type = 'rental_license' AND confirmation_letter IS NOT NULL LIMIT 1`
      ).get(propertyId);
      const letter = result.confirmation_letter || (existing && existing.confirmation_letter) || null;

      db.prepare(`DELETE FROM rental_licenses WHERE property_id = ? AND municipality = 'baltimore_county' AND license_type = 'rental_license'`).run(propertyId);
      const ins = db.prepare(`INSERT INTO rental_licenses (property_id, municipality, license_type, unit, license_number, status, issue_date, exp_date, confirmation_letter, scraped_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`);
      result.licenses.forEach((l, i) => {
        ins.run(propertyId, 'baltimore_county', 'rental_license', l.unit || '', l.license_number, l.status, l.issue_date || null, l.exp_date || null, i === 0 ? letter : null);
      });
    } else {
      upsertLicense(propertyId, 'baltimore_county', result);
    }
  }

  // Download stored confirmation letter PDF
  router.get('/rental-license/letter/:propertyId/:municipality', (req, res) => {
    const row = db.prepare(`SELECT confirmation_letter FROM rental_licenses WHERE property_id = ? AND municipality = ? AND license_type = 'rental_license'`).get(req.params.propertyId, req.params.municipality);
    if (!row || !row.confirmation_letter) return res.status(404).json({ error: 'No letter on file' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="rental-registration-${req.params.propertyId}.pdf"`);
    res.send(Buffer.from(row.confirmation_letter));
  });

  // Trigger Baltimore County rental license check
  router.post('/rental-license/county/:propertyId', aw(async (req, res) => {
    const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.propertyId);
    if (!property) return res.status(404).json({ error: 'Not found' });
    if (property.municipality !== 'baltimore_county') return res.status(400).json({ error: 'Not a Baltimore County property' });

    // ?pdf=1 also pulls the certificate from the Accela portal (slow).
    const result = await scrapeRentalLicenseBaltimoreCounty(property, { downloadPdf: req.query.pdf === '1' });
    if (result.error) return res.status(422).json({ error: result.error });
    storeCountyResult(property.id, result);
    res.json(result);
  }));

  // Keep old path working
  router.post('/rental-license/baltimore-county/:propertyId', aw(async (req, res) => {
    const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.propertyId);
    if (!property) return res.status(404).json({ error: 'Not found' });
    const result = await scrapeRentalLicenseBaltimoreCounty(property);
    if (result.error) return res.status(422).json({ error: result.error });
    storeCountyResult(property.id, result);
    res.json(result);
  }));

  // Trigger Baltimore City rental license check
  router.post('/rental-license/city/:propertyId', aw(async (req, res) => {
    const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.propertyId);
    if (!property) return res.status(404).json({ error: 'Not found' });
    if (property.municipality !== 'baltimore_city') return res.status(400).json({ error: 'Not a Baltimore City property' });

    // No location ID yet? Try to discover it so this check uses the live API.
    if (!property.opengov_location_id) {
      try {
        await discoverOpenGovIds();
        const fresh = db.prepare(`SELECT opengov_location_id FROM properties WHERE id = ?`).get(property.id);
        if (fresh) property.opengov_location_id = fresh.opengov_location_id;
      } catch (err) {
        console.log(`[opengov] discovery failed for ${property.name}: ${err.message}`);
      }
    }

    const result = await scrapeRentalLicenseBaltimoreCity(property);
    if (result.error) return res.status(422).json({ error: result.error });
    storeCityResult(property.id, result);
    res.json(result);
  }));

  // Fill in Baltimore City OpenGov location IDs automatically by matching the
  // addresses on records filed under our OpenGov account. Safe to re-run: it
  // only fills blanks unless ?force=1.
  async function discoverOpenGovIds({ force = false } = {}) {
    const targets = db.prepare(
      `SELECT id, name, address, opengov_location_id FROM properties
        WHERE active = 1 AND municipality = 'baltimore_city'`
    ).all();
    const pending = targets.filter(p => force || !p.opengov_location_id);
    if (!pending.length) return { matched: [], unmatched: [], locations: 0 };

    const matched = [], unmatched = [];
    let byKey = null;   // account harvest, only built if the public lookup misses

    for (const p of pending) {
      // Public path: city parcel data gives the ZIP+4 the locations endpoint
      // needs. Works for any address, whoever filed the records.
      let locationID = null, needsUnit = null;
      try {
        const hit = await resolveLocationIdByAddress(p.address);
        if (hit && hit.needsUnit) needsUnit = hit.units;
        else if (hit) locationID = hit.locationID;
      } catch (err) {
        console.log(`[opengov] address lookup failed for ${p.name}: ${err.message}`);
      }

      // Fallback: records filed under our own OpenGov account — which also
      // pins down the right unit when the address doesn't name one.
      if (!locationID) {
        if (byKey === null) {
          byKey = new Map();
          const setting = db.prepare(`SELECT value FROM settings WHERE key = 'opengov_user_id'`).get();
          if (setting && setting.value) {
            try {
              for (const loc of await harvestOpenGovLocations(setting.value)) {
                if (loc.key && !byKey.has(loc.key)) byKey.set(loc.key, loc);
              }
            } catch (err) {
              console.log(`[opengov] account harvest failed: ${err.message}`);
            }
          }
        }
        const hit = byKey.get(keyFromAddress(p.address));
        if (hit) locationID = hit.locationID;
      }

      if (!locationID) {
        const reason = needsUnit
          ? `DHCD lists only units at this address (${needsUnit.slice(0, 6).join(', ')}) — add the unit number to the address`
          : 'no DHCD record found for this address';
        console.log(`[opengov] ${p.name}: ${reason}`);
        unmatched.push({ id: p.id, name: p.name, address: p.address, reason });
        continue;
      }
      db.prepare(`UPDATE properties SET opengov_location_id = ? WHERE id = ?`).run(String(locationID), p.id);
      matched.push({ id: p.id, name: p.name, locationID });
    }

    console.log(`[opengov] discovery: ${matched.length} matched, ${unmatched.length} unmatched (of ${pending.length} checked)`);
    return { locations: matched.length, matched, unmatched };
  }

  router.post('/opengov-discover', aw(async (req, res) => {
    try {
      const out = await discoverOpenGovIds({ force: req.query.force === '1' });
      if (out.error) return res.status(400).json(out);
      res.json(out);
    } catch (err) {
      res.status(422).json({ error: err.message });
    }
  }));

  // Bulk: update all rental licenses (Baltimore City + County)
  router.post('/update-all-licenses', aw(async (req, res) => {
    // Self-heal: pick up location IDs for any city property still missing one
    // so the live OpenGov API is used instead of the stale GIS extract.
    try { await discoverOpenGovIds(); } catch (err) {
      console.log(`[opengov] discovery skipped: ${err.message}`);
    }
    const properties = db.prepare(`SELECT * FROM properties WHERE active = 1 AND municipality IN ('baltimore_county', 'baltimore_city')`).all();
    const results = [];
    let failed = 0;
    for (const property of properties) {
      // One property's network hiccup must not abandon the rest of the run.
      let result;
      try {
        result = property.municipality === 'baltimore_county'
          ? await scrapeRentalLicenseBaltimoreCounty(property)
          : await scrapeRentalLicenseBaltimoreCity(property);
      } catch (err) {
        failed++;
        console.log(`[licenses] ${property.name} failed: ${err.message}`);
        results.push({ id: property.id, name: property.name, municipality: property.municipality, error: err.message });
        continue;
      }
      if (!result.error) {
        if (property.municipality === 'baltimore_city') storeCityResult(property.id, result);
        else storeCountyResult(property.id, result);
      }
      results.push({ id: property.id, name: property.name, municipality: property.municipality, ...result });
    }
    res.json({ updated: results.length - failed, failed, results });
  }));

  // Trigger MDE lead registration + certificate check, persist to lead_records
  router.post('/mde/:propertyId', aw(async (req, res) => {
    const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.propertyId);
    if (!property) return res.status(404).json({ error: 'Not found' });

    const reg = await scrapeMdeRegistration(property);
    const cert = await scrapeMdeCertificate(property);

    if (reg.error && cert.error) {
      return res.status(422).json({ error: `Registration: ${reg.error} / Certificate: ${cert.error}` });
    }

    const registered = !reg.error && reg.registered;
    const certFound = !cert.error && cert.cert_found;

    if (registered || certFound) {
      const notes = [
        registered ? `MDE registered${reg.owner_name ? ' — ' + reg.owner_name.split('\n')[0] : ''}` : 'Not in MDE registry',
        certFound ? `Cert ${cert.cert_number || ''} ${cert.cert_status || ''}`.trim() : 'No inspection certificate',
      ].join('; ');

      const existing = db.prepare(`SELECT id FROM lead_records WHERE property_id = ? AND source = 'mde'`).get(property.id);
      const vals = {
        tracking_id: registered ? reg.tracking_id : null,
        registration_date: registered ? normalizeUsDate(reg.registration_date) : null,
        registration_status: registered ? reg.status : 'not_found',
        cert_number: certFound ? cert.cert_number : null,
        cert_status: certFound ? cert.cert_status : null,
        inspection_date: certFound ? normalizeUsDate(cert.inspection_date) : null,
        owner_name: registered ? reg.owner_name : null,
        owner_address: registered ? reg.owner_address : null,
        bank_date: registered ? normalizeUsDate(reg.bank_date) : null,
        payment_year: registered ? reg.payment_year : null,
        cert_pdf: certFound ? (cert.cert_pdf || null) : null,
      };
      if (existing) {
        db.prepare(`UPDATE lead_records SET tracking_id=?, registration_date=?, registration_status=?, cert_number=?, cert_status=?, inspection_date=?, owner_name=?, owner_address=?, bank_date=?, payment_year=?, cert_pdf=COALESCE(?, cert_pdf), notes=? WHERE id=?`)
          .run(vals.tracking_id, vals.registration_date, vals.registration_status, vals.cert_number, vals.cert_status, vals.inspection_date, vals.owner_name, vals.owner_address, vals.bank_date, vals.payment_year, vals.cert_pdf, notes, existing.id);
      } else {
        db.prepare(`INSERT INTO lead_records (property_id, tracking_id, registration_date, registration_status, cert_number, cert_status, inspection_date, owner_name, owner_address, bank_date, payment_year, cert_pdf, notes, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'mde')`)
          .run(property.id, vals.tracking_id, vals.registration_date, vals.registration_status, vals.cert_number, vals.cert_status, vals.inspection_date, vals.owner_name, vals.owner_address, vals.bank_date, vals.payment_year, vals.cert_pdf, notes);
      }

      // Multifamily: store one record per unit (latest cert each)
      if (property.multifamily && certFound && Array.isArray(cert.units)) {
        db.prepare(`DELETE FROM lead_records WHERE property_id = ? AND source = 'mde-unit'`).run(property.id);
        const ins = db.prepare(`INSERT INTO lead_records (property_id, unit, cert_number, cert_status, inspection_date, cert_pdf, source) VALUES (?,?,?,?,?,?,'mde-unit')`);
        for (const u of cert.units) {
          ins.run(property.id, u.unit || '', u.cert_number, u.cert_status, normalizeUsDate(u.inspection_date), u.cert_pdf || null);
        }
      }
    }

    res.json({ registration: reg, certificate: cert, saved: registered || certFound });
  }));

  // ── Licensing dashboard ───────────────────────────────────────────────────
  router.get('/licenses', (req, res) => {
    const props = db.prepare(`SELECT id, name, address, municipality, commercial, license_not_monitored FROM properties WHERE active = 1 ORDER BY name`).all();
    const rows = props.map(p => {
      const licenses = db.prepare(`SELECT unit, license_number, status, issue_date, exp_date, notes, scraped_at, (confirmation_letter IS NOT NULL) as has_letter FROM rental_licenses WHERE property_id = ? AND municipality = ? AND license_type = 'rental_license' ORDER BY unit`).all(p.id, p.municipality);
      const reg = db.prepare(`SELECT license_number, status, exp_date, notes FROM rental_licenses WHERE property_id = ? AND municipality = ? AND license_type = 'registration'`).get(p.id, p.municipality);
      const first = licenses[0] || {};
      return {
        ...p,
        licenses,
        // flat fields (first/summary row) keep sorting simple
        license_number: first.license_number || null,
        status: licenses.length > 1
          ? (licenses.every(l => l.status === 'active') ? 'active' : 'expired')
          : (first.status || null),
        issue_date: first.issue_date || null,
        exp_date: first.exp_date || null,
        scraped_at: first.scraped_at || null,
        has_letter: licenses.some(l => l.has_letter),
        reg_number: reg?.license_number || null,
        reg_status: reg?.status || null,
        reg_exp_date: reg?.exp_date || null,
        reg_url: reg?.notes?.startsWith('http') ? reg.notes : null,
        license_url: licenses[0]?.notes?.startsWith('http') ? licenses[0].notes : null,
      };
    });
    res.json(rows);
  });

  // ── Lead Registry dashboard ───────────────────────────────────────────────
  router.get('/lead-registry', (req, res) => {
    const props = db.prepare(`SELECT * FROM properties WHERE active = 1 ORDER BY name`).all();
    const out = props.map(p => {
      const rec = db.prepare(`SELECT * FROM lead_records WHERE property_id = ? AND source = 'mde'`).get(p.id);
      const hiddenUnits = parseHiddenUnits(p.hidden_lead_units);
      const units = db.prepare(`SELECT unit, cert_number, cert_status, inspection_date, (cert_pdf IS NOT NULL) as has_pdf FROM lead_records WHERE property_id = ? AND source = 'mde-unit' ORDER BY unit`).all(p.id)
        .map(u => ({ ...u, hidden: hiddenUnits.includes(u.unit || '') ? 1 : 0 }));
      return {
        id: p.id, name: p.name, address: p.address, municipality: p.municipality,
        year_built: p.year_built, commercial: p.commercial, lead_not_monitored: p.lead_not_monitored,
        multifamily: p.multifamily, owner_name: p.owner_name, owner_address: p.owner_address,
        tracking_id: rec?.tracking_id || null,
        registry_owner: rec?.owner_name || null,
        registry_owner_address: rec?.owner_address || null,
        registration_date: rec?.registration_date || null,
        bank_date: rec?.bank_date || null,
        payment_year: rec?.payment_year || null,
        cert_number: rec?.cert_number || null,
        cert_status: rec?.cert_status || null,
        inspection_date: rec?.inspection_date || null,
        has_cert_pdf: rec?.cert_pdf ? 1 : 0,
        owner_name_match: looseMatch(p.owner_name, rec?.owner_name),
        owner_address_match: looseMatch(p.owner_address, rec?.owner_address),
        units,
      };
    });
    res.json(out);
  });

  // Serve a stored lead inspection certificate PDF (?unit= for multifamily units)
  router.get('/lead-cert-pdf/:propertyId', (req, res) => {
    const unit = req.query.unit;
    const row = unit != null
      ? db.prepare(`SELECT cert_pdf FROM lead_records WHERE property_id = ? AND source = 'mde-unit' AND unit = ?`).get(req.params.propertyId, unit)
      : db.prepare(`SELECT cert_pdf FROM lead_records WHERE property_id = ? AND source = 'mde'`).get(req.params.propertyId);
    if (!row || !row.cert_pdf) return res.status(404).json({ error: 'No certificate PDF on file' });
    const buf = Buffer.from(row.cert_pdf); // sql.js returns Uint8Array — res.send would JSON-serialize it
    if (buf.slice(0, 4).toString() !== '%PDF') {
      console.log(`[lead-cert-pdf] stored blob for ${req.params.propertyId}/${unit || ''} is not a PDF (starts: ${buf.slice(0, 20).toString().replace(/\n/g, ' ')})`);
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="lead-cert-${req.params.propertyId}${unit ? '-' + unit : ''}.pdf"`);
    res.send(buf);
  });

  // Hide/unhide a lead unit row (stale MDE entries that don't map to real units)
  router.post('/lead-unit-hide/:propertyId', (req, res) => {
    const property = db.prepare(`SELECT id, hidden_lead_units FROM properties WHERE id = ?`).get(req.params.propertyId);
    if (!property) return res.status(404).json({ error: 'Not found' });
    const { unit, hidden } = req.body || {};
    if (unit == null) return res.status(400).json({ error: 'unit required' });

    const list = new Set(parseHiddenUnits(property.hidden_lead_units));
    if (hidden) list.add(unit); else list.delete(unit);
    db.prepare(`UPDATE properties SET hidden_lead_units = ? WHERE id = ?`).run(JSON.stringify([...list]), property.id);
    res.json({ ok: true, hidden_lead_units: [...list] });
  });

  // ── Tax mailing address (SDAT) dashboard ─────────────────────────────────
  function taxAddressFlag(p) {
    if (!p.sdat_mailing_address) return { status: 'unknown', label: 'Not checked' };
    // Mailing address pointing at the property itself → tax bills go to the rental
    const propStreet = (p.address || '').split(',')[0];
    if (looseMatch(propStreet, p.sdat_mailing_address)) {
      return { status: 'red', label: 'Mails to property address' };
    }
    const ownerOk = looseMatch(p.owner_address, p.sdat_mailing_address);
    if (ownerOk === true) return { status: 'green', label: 'Matches owner address' };
    if (ownerOk === null) return { status: 'yellow', label: 'No owner address on file to compare' };
    // Title held by an LLC while SDAT still lists the individual (or vice
    // versa) is a known, accepted difference on these properties.
    if (p.ignore_name_mismatch) return { status: 'na', label: 'Mismatch accepted' };
    return { status: 'red', label: 'Does not match owner address' };
  }

  router.get('/tax-address', (req, res) => {
    const props = db.prepare(`SELECT id, name, address, municipality, owner_name, owner_address, tax_id, sdat_mailing_address, sdat_checked_at, ignore_name_mismatch FROM properties WHERE active = 1 ORDER BY name`).all();
    res.json(props.map(p => ({ ...p, flag: taxAddressFlag(p) })));
  });

  router.post('/tax-address/:propertyId', aw(async (req, res) => {
    const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.propertyId);
    if (!property) return res.status(404).json({ error: 'Not found' });

    const result = await lookupSdatMailing(property);
    if (result.error) return res.status(422).json({ error: result.error });

    db.prepare(`UPDATE properties SET sdat_mailing_address = ?, sdat_checked_at = datetime('now'), tax_id = COALESCE(NULLIF(tax_id, ''), ?), owner_name = COALESCE(NULLIF(owner_name, ''), ?) WHERE id = ?`)
      .run(result.mailing_address, result.tax_id, result.owner_name || null, property.id);

    const updated = db.prepare(`SELECT id, name, address, municipality, owner_name, owner_address, tax_id, sdat_mailing_address, sdat_checked_at, ignore_name_mismatch FROM properties WHERE id = ?`).get(property.id);
    res.json({ ...updated, flag: taxAddressFlag(updated) });
  }));

  router.post('/tax-address-all', aw(async (req, res) => {
    const props = db.prepare(`SELECT * FROM properties WHERE active = 1`).all();
    const results = [];
    for (const property of props) {
      const result = await lookupSdatMailing(property);
      if (!result.error) {
        db.prepare(`UPDATE properties SET sdat_mailing_address = ?, sdat_checked_at = datetime('now'), tax_id = COALESCE(NULLIF(tax_id, ''), ?), owner_name = COALESCE(NULLIF(owner_name, ''), ?) WHERE id = ?`)
          .run(result.mailing_address, result.tax_id, result.owner_name || null, property.id);
      }
      results.push({ id: property.id, name: property.name, ...result });
    }
    res.json({ checked: results.length, results });
  }));

  return router;
};
