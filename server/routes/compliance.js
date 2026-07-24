'use strict';
const { Router } = require('express');
const { lookupSdat } = require('../scrapers/sdat');
const { scrapeRentalLicenseBaltimoreCounty } = require('../scrapers/rentalLicenseBaltimoreCounty');
const { scrapeRentalLicenseBaltimoreCity } = require('../scrapers/rentalLicenseBaltimoreCity');
const { scrapeMdeRegistration, scrapeMdeCertificate } = require('../scrapers/mde');

const DAYS = ms => Math.round(ms / 86400000);

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
  const active = relevant.find(l => l.status === 'active');
  if (!active) {
    const expired = relevant.find(l => l.status === 'expired');
    return expired ? { status: 'red', label: `Expired ${expired.exp_date || ''}` } : { status: 'yellow', label: relevant[0].status };
  }
  if (active.exp_date) {
    const daysLeft = DAYS(new Date(active.exp_date) - new Date());
    if (daysLeft < 0) return { status: 'red', label: `Expired ${active.exp_date}` };
    if (daysLeft < 60) return { status: 'yellow', label: `Expires in ${daysLeft}d` };
  }
  return { status: 'green', label: active.exp_date ? `Expires ${active.exp_date}` : 'Active' };
}

function leadStatus(property, leadRecords) {
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

  if (leadRecords.length === 0) return { status: 'red', label: 'No lead records' };
  const latest = leadRecords[0];
  const exp = latest.cert_exp_date;
  if (exp) {
    const daysLeft = DAYS(new Date(exp) - new Date());
    if (daysLeft < 0) return { status: 'red', label: `Cert expired ${exp}` };
    if (daysLeft < 60) return { status: 'yellow', label: `Cert exp in ${daysLeft}d` };
    return { status: 'green', label: `Cert exp ${exp}` };
  }
  const registered = latest.registration_status && latest.registration_status !== 'not_found';
  const certPassed = (latest.cert_status || '').toUpperCase().includes('PASS');
  // MDE registration must be renewed every year — only current-year registrations count
  const regYear = latest.registration_date ? new Date(latest.registration_date).getFullYear() : null;
  const currentYear = new Date().getFullYear();
  const regCurrent = registered && regYear === currentYear;

  if (registered && !regCurrent) {
    return { status: 'red', label: `Registration not renewed for ${currentYear} (last ${latest.registration_date || 'unknown'})` };
  }
  if (regCurrent && certPassed) return { status: 'green', label: `Registered ${currentYear} · Cert ${latest.cert_number} passed` };
  if (regCurrent) return { status: 'yellow', label: `Registered ${currentYear} · no cert` };
  if (certPassed) return { status: 'yellow', label: `Cert ${latest.cert_number} passed · not registered` };
  if (latest.inspection_date) return { status: 'green', label: `Inspected ${latest.inspection_date}` };
  return { status: 'yellow', label: 'Lead record on file' };
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
      const licenses = db.prepare(`SELECT id, municipality, license_type, license_number, status, issue_date, exp_date, scraped_at, notes, (confirmation_letter IS NOT NULL) as has_letter FROM rental_licenses WHERE property_id = ?`).all(p.id);
      const leadRecords = db.prepare(`SELECT * FROM lead_records WHERE property_id = ? ORDER BY inspection_date DESC`).all(p.id);

      const needsRentalLicense = p.municipality === 'baltimore_city' || p.municipality === 'baltimore_county';

      return {
        id: p.id,
        name: p.name,
        address: p.address,
        municipality: p.municipality,
        year_built: p.year_built,
        lead_free: p.lead_free,
        private_ws: p.private_ws,
        water: billStatus(p),
        rental_license: needsRentalLicense ? rentalLicenseStatus(licenses, p.municipality) : { status: 'na', label: 'N/A' },
        rental_license_has_letter: licenses.some(l => l.municipality === p.municipality && l.has_letter),
        lead: leadStatus(p, leadRecords),
      };
    });

    res.json(result);
  });

  // Trigger SDAT lookup for a property
  router.post('/sdat/:propertyId', async (req, res) => {
    const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.propertyId);
    if (!property) return res.status(404).json({ error: 'Not found' });

    const result = await lookupSdat(property);
    if (result.error) return res.status(422).json({ error: result.error });

    if (result.year_built) {
      db.prepare(`UPDATE properties SET year_built = ?, sdat_acct = ? WHERE id = ?`)
        .run(result.year_built, result.sdat_acct || property.sdat_acct, property.id);
    }
    res.json(result);
  });

  // Helper to upsert a rental license result (including optional confirmation_letter blob)
  function upsertLicense(propertyId, municipality, result) {
    const letter = result.confirmation_letter || null;
    const existing = db.prepare(`SELECT id FROM rental_licenses WHERE property_id = ? AND municipality = ? AND license_type = 'rental_license'`).get(propertyId, municipality);
    if (existing) {
      const stmt = letter
        ? db.prepare(`UPDATE rental_licenses SET license_number=?, status=?, issue_date=?, exp_date=?, confirmation_letter=?, scraped_at=datetime('now') WHERE id=?`)
        : db.prepare(`UPDATE rental_licenses SET license_number=?, status=?, issue_date=?, exp_date=?, scraped_at=datetime('now') WHERE id=?`);
      letter
        ? stmt.run(result.license_number, result.status, result.issue_date || null, result.exp_date || null, letter, existing.id)
        : stmt.run(result.license_number, result.status, result.issue_date || null, result.exp_date || null, existing.id);
    } else {
      db.prepare(`INSERT INTO rental_licenses (property_id, municipality, license_type, license_number, status, issue_date, exp_date, confirmation_letter, scraped_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
        .run(propertyId, municipality, 'rental_license', result.license_number, result.status, result.issue_date || null, result.exp_date || null, letter);
    }
  }

  // Download stored confirmation letter PDF
  router.get('/rental-license/letter/:propertyId/:municipality', (req, res) => {
    const row = db.prepare(`SELECT confirmation_letter FROM rental_licenses WHERE property_id = ? AND municipality = ? AND license_type = 'rental_license'`).get(req.params.propertyId, req.params.municipality);
    if (!row || !row.confirmation_letter) return res.status(404).json({ error: 'No letter on file' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="rental-registration-${req.params.propertyId}.pdf"`);
    res.send(row.confirmation_letter);
  });

  // Trigger Baltimore County rental license check
  router.post('/rental-license/county/:propertyId', async (req, res) => {
    const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.propertyId);
    if (!property) return res.status(404).json({ error: 'Not found' });
    if (property.municipality !== 'baltimore_county') return res.status(400).json({ error: 'Not a Baltimore County property' });

    const result = await scrapeRentalLicenseBaltimoreCounty(property);
    if (result.error) return res.status(422).json({ error: result.error });
    upsertLicense(property.id, 'baltimore_county', result);
    res.json(result);
  });

  // Keep old path working
  router.post('/rental-license/baltimore-county/:propertyId', async (req, res) => {
    const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.propertyId);
    if (!property) return res.status(404).json({ error: 'Not found' });
    const result = await scrapeRentalLicenseBaltimoreCounty(property);
    if (result.error) return res.status(422).json({ error: result.error });
    upsertLicense(property.id, 'baltimore_county', result);
    res.json(result);
  });

  // Trigger Baltimore City rental license check
  router.post('/rental-license/city/:propertyId', async (req, res) => {
    const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.propertyId);
    if (!property) return res.status(404).json({ error: 'Not found' });
    if (property.municipality !== 'baltimore_city') return res.status(400).json({ error: 'Not a Baltimore City property' });

    const result = await scrapeRentalLicenseBaltimoreCity(property);
    if (result.error) return res.status(422).json({ error: result.error });
    upsertLicense(property.id, 'baltimore_city', result);
    res.json(result);
  });

  // Bulk: update all rental licenses (Baltimore City + County)
  router.post('/update-all-licenses', async (req, res) => {
    const properties = db.prepare(`SELECT * FROM properties WHERE active = 1 AND municipality IN ('baltimore_county', 'baltimore_city')`).all();
    const results = [];
    for (const property of properties) {
      let result;
      if (property.municipality === 'baltimore_county') {
        result = await scrapeRentalLicenseBaltimoreCounty(property);
      } else {
        result = await scrapeRentalLicenseBaltimoreCity(property);
      }
      if (!result.error) {
        upsertLicense(property.id, property.municipality, result);
      }
      results.push({ id: property.id, name: property.name, municipality: property.municipality, ...result });
    }
    res.json({ updated: results.length, results });
  });

  // Trigger MDE lead registration + certificate check, persist to lead_records
  router.post('/mde/:propertyId', async (req, res) => {
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
      };
      if (existing) {
        db.prepare(`UPDATE lead_records SET tracking_id=?, registration_date=?, registration_status=?, cert_number=?, cert_status=?, inspection_date=?, notes=? WHERE id=?`)
          .run(vals.tracking_id, vals.registration_date, vals.registration_status, vals.cert_number, vals.cert_status, vals.inspection_date, notes, existing.id);
      } else {
        db.prepare(`INSERT INTO lead_records (property_id, tracking_id, registration_date, registration_status, cert_number, cert_status, inspection_date, notes, source) VALUES (?,?,?,?,?,?,?,?,'mde')`)
          .run(property.id, vals.tracking_id, vals.registration_date, vals.registration_status, vals.cert_number, vals.cert_status, vals.inspection_date, notes);
      }
    }

    res.json({ registration: reg, certificate: cert, saved: registered || certFound });
  });

  return router;
};
