'use strict';
const { Router } = require('express');
const { lookupSdat } = require('../scrapers/sdat');
const { scrapeRentalLicenseBaltimoreCounty } = require('../scrapers/rentalLicenseBaltimoreCounty');
const { scrapeRentalLicenseBaltimoreCity } = require('../scrapers/rentalLicenseBaltimoreCity');
const { scrapeMdeRegistration } = require('../scrapers/mde');

const DAYS = ms => Math.round(ms / 86400000);

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
      const licenses = db.prepare(`SELECT * FROM rental_licenses WHERE property_id = ?`).all(p.id);
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

  // Helper to upsert a rental license result
  function upsertLicense(propertyId, municipality, result) {
    const existing = db.prepare(`SELECT id FROM rental_licenses WHERE property_id = ? AND municipality = ? AND license_type = 'rental_license'`).get(propertyId, municipality);
    if (existing) {
      db.prepare(`UPDATE rental_licenses SET license_number=?, status=?, issue_date=?, exp_date=?, scraped_at=datetime('now') WHERE id=?`)
        .run(result.license_number, result.status, result.issue_date || null, result.exp_date || null, existing.id);
    } else {
      db.prepare(`INSERT INTO rental_licenses (property_id, municipality, license_type, license_number, status, issue_date, exp_date, scraped_at) VALUES (?,?,?,?,?,?,?,datetime('now'))`)
        .run(propertyId, municipality, 'rental_license', result.license_number, result.status, result.issue_date || null, result.exp_date || null);
    }
  }

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

  // Trigger MDE lead registration check
  router.post('/mde/:propertyId', async (req, res) => {
    const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.propertyId);
    if (!property) return res.status(404).json({ error: 'Not found' });

    const result = await scrapeMdeRegistration(property);
    if (result.error) return res.status(422).json({ error: result.error });
    res.json(result);
  });

  return router;
};
