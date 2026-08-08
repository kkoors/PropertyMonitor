'use strict';
const { Router } = require('express');
const { encrypt, decrypt } = require('../db');

module.exports = function makePropertiesRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM bills b WHERE b.property_id = p.id) as bill_count,
        (SELECT COUNT(*) FROM bills b WHERE b.property_id = p.id AND b.status = 'new') as new_bill_count,
        (SELECT b.bill_date   FROM bills b WHERE b.property_id = p.id ORDER BY b.created_at DESC LIMIT 1) as latest_bill_date,
        (SELECT b.amount_due  FROM bills b WHERE b.property_id = p.id ORDER BY b.created_at DESC LIMIT 1) as latest_amount,
        (SELECT b.due_date    FROM bills b WHERE b.property_id = p.id ORDER BY b.created_at DESC LIMIT 1) as latest_due_date,
        (SELECT b.last_pay_date   FROM bills b WHERE b.property_id = p.id AND b.last_pay_date IS NOT NULL ORDER BY b.created_at DESC LIMIT 1) as last_pay_date,
        (SELECT b.last_pay_amount FROM bills b WHERE b.property_id = p.id AND b.last_pay_amount IS NOT NULL ORDER BY b.created_at DESC LIMIT 1) as last_pay_amount
      FROM properties p ORDER BY p.name
    `).all();
    res.json(rows);
  });

  router.get('/:id', (req, res) => {
    const row = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });

  router.post('/', (req, res) => {
    const { name, address, municipality, account_number, notes, private_ws, year_built, lead_free, lead_free_cert_date, lead_free_cert_exp_date, owner_name, owner_address, commercial, multifamily, lead_not_monitored, license_not_monitored, tax_id, water_mailing_address, opengov_location_id, ignore_name_mismatch, water_responsibility, acn_not_monitored } = req.body;
    if (!name || !address || !municipality) {
      return res.status(400).json({ error: 'name, address, and municipality are required' });
    }
    const result = db.prepare(`
      INSERT INTO properties (name, address, municipality, account_number, notes, private_ws, year_built, lead_free, lead_free_cert_date, lead_free_cert_exp_date, owner_name, owner_address, commercial, multifamily, lead_not_monitored, license_not_monitored, tax_id, water_mailing_address, opengov_location_id, ignore_name_mismatch, water_responsibility, acn_not_monitored)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, address, municipality, account_number || null, notes || null, private_ws ? 1 : 0, year_built || null, lead_free ? 1 : 0, lead_free_cert_date || null, lead_free_cert_exp_date || null, owner_name || null, owner_address || null, commercial ? 1 : 0, multifamily ? 1 : 0, lead_not_monitored ? 1 : 0, license_not_monitored ? 1 : 0, tax_id || null, water_mailing_address || null, opengov_location_id || null, ignore_name_mismatch ? 1 : 0, water_responsibility || 'management', acn_not_monitored ? 1 : 0);
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.put('/:id', (req, res) => {
    const { name, address, municipality, account_number, notes, active, private_ws, year_built, lead_free, lead_free_cert_date, lead_free_cert_exp_date, owner_name, owner_address, commercial, multifamily, lead_not_monitored, license_not_monitored, tax_id, water_mailing_address, opengov_location_id, ignore_name_mismatch, water_responsibility, acn_not_monitored } = req.body;
    db.prepare(`
      UPDATE properties SET name=?, address=?, municipality=?, account_number=?, notes=?, active=?, private_ws=?,
        year_built=?, lead_free=?, lead_free_cert_date=?, lead_free_cert_exp_date=?, owner_name=?, owner_address=?, commercial=?, multifamily=?, lead_not_monitored=?, license_not_monitored=?, tax_id=?, water_mailing_address=?, opengov_location_id=?, ignore_name_mismatch=?, water_responsibility=?, acn_not_monitored=?
      WHERE id=?
    `).run(name, address, municipality, account_number, notes, active ?? 1, private_ws ? 1 : 0, year_built || null, lead_free ? 1 : 0, lead_free_cert_date || null, lead_free_cert_exp_date || null, owner_name || null, owner_address || null, commercial ? 1 : 0, multifamily ? 1 : 0, lead_not_monitored ? 1 : 0, license_not_monitored ? 1 : 0, tax_id || null, water_mailing_address || null, opengov_location_id || null, ignore_name_mismatch ? 1 : 0, water_responsibility || 'management', acn_not_monitored ? 1 : 0, req.params.id);
    res.json({ ok: true });
  });

  // Bulk import from AppFolio CSV (rows already parsed/mapped client-side).
  // Matches existing properties by street line of the address; updates owner
  // info on matches, creates the rest.
  router.post('/import', async (req, res) => {
    const { rows } = req.body || {};
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows array required' });

    // The very same matcher the import preview ran, so what it showed as
    // "Update" can't arrive here as a second copy.
    const { buildMatchIndex } = await import('../../shared/addressMatch.mjs');
    const index = buildMatchIndex(db.prepare(`SELECT id, address FROM properties`).all());

    let created = 0, updated = 0, skipped = 0;
    for (const row of rows) {
      if (row.skip) { skipped++; continue; }
      if (!row.address) { skipped++; continue; }
      const match = index.find(row.address)?.property;

      if (match) {
        db.prepare(`UPDATE properties SET
            owner_name = COALESCE(NULLIF(?, ''), owner_name),
            owner_address = COALESCE(NULLIF(?, ''), owner_address),
            name = CASE WHEN name = '' OR name IS NULL THEN ? ELSE name END
          WHERE id = ?`)
          .run(row.owner_name || '', row.owner_address || '', row.name || '', match.id);
        updated++;
      } else {
        if (!row.name || !row.municipality) { skipped++; continue; }
        db.prepare(`INSERT INTO properties (name, address, municipality, owner_name, owner_address) VALUES (?,?,?,?,?)`)
          .run(row.name, row.address, row.municipality, row.owner_name || null, row.owner_address || null);
        created++;
      }
    }
    res.json({ created, updated, skipped });
  });

  router.delete('/:id', (req, res) => {
    db.prepare(`DELETE FROM bills WHERE property_id = ?`).run(req.params.id);
    db.prepare(`DELETE FROM credentials WHERE property_id = ?`).run(req.params.id);
    db.prepare(`DELETE FROM properties WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });

  router.put('/:id/credentials', (req, res) => {
    const { portal, username, password } = req.body;
    if (!portal || !username || !password) {
      return res.status(400).json({ error: 'portal, username, and password are required' });
    }
    const { enc: username_enc, iv } = encrypt(username);
    const { enc: password_enc } = encrypt(password);

    // upsert: delete then insert (sql.js doesn't support ON CONFLICT DO UPDATE easily)
    db.prepare(`DELETE FROM credentials WHERE property_id = ? AND portal = ?`).run(req.params.id, portal);
    db.prepare(`
      INSERT INTO credentials (property_id, portal, username_enc, password_enc, iv)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.params.id, portal, username_enc, password_enc, iv);

    res.json({ ok: true });
  });

  router.get('/:id/credentials', (req, res) => {
    const rows = db.prepare(`SELECT portal, created_at FROM credentials WHERE property_id = ?`).all(req.params.id);
    res.json(rows);
  });

  return router;
};
