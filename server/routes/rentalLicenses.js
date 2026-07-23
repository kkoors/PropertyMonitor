'use strict';
const { Router } = require('express');

module.exports = function makeRentalLicensesRouter(db) {
  const router = Router();

  router.get('/:propertyId', (req, res) => {
    const rows = db.prepare(`SELECT * FROM rental_licenses WHERE property_id = ? ORDER BY municipality, license_type`).all(req.params.propertyId);
    res.json(rows);
  });

  router.post('/:propertyId', (req, res) => {
    const { municipality, license_type, license_number, status, holder_name, issue_date, exp_date, notes } = req.body;
    const result = db.prepare(`
      INSERT INTO rental_licenses (property_id, municipality, license_type, license_number, status, holder_name, issue_date, exp_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.propertyId, municipality, license_type || 'rental_license', license_number || null, status || 'unknown', holder_name || null, issue_date || null, exp_date || null, notes || null);
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.put('/:id', (req, res) => {
    const { municipality, license_type, license_number, status, holder_name, issue_date, exp_date, notes } = req.body;
    db.prepare(`
      UPDATE rental_licenses SET municipality=?, license_type=?, license_number=?, status=?, holder_name=?, issue_date=?, exp_date=?, notes=? WHERE id=?
    `).run(municipality, license_type || 'rental_license', license_number || null, status || 'unknown', holder_name || null, issue_date || null, exp_date || null, notes || null, req.params.id);
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    db.prepare(`DELETE FROM rental_licenses WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });

  return router;
};
