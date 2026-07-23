'use strict';
const { Router } = require('express');

module.exports = function makeLeadRouter(db) {
  const router = Router();

  router.get('/:propertyId', (req, res) => {
    const rows = db.prepare(`SELECT * FROM lead_records WHERE property_id = ? ORDER BY inspection_date DESC`).all(req.params.propertyId);
    res.json(rows);
  });

  router.post('/:propertyId', (req, res) => {
    const { turnover_date, inspection_date, cert_number, cert_exp_date, notes } = req.body;
    const result = db.prepare(`
      INSERT INTO lead_records (property_id, turnover_date, inspection_date, cert_number, cert_exp_date, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.params.propertyId, turnover_date || null, inspection_date || null, cert_number || null, cert_exp_date || null, notes || null);
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.put('/:id', (req, res) => {
    const { turnover_date, inspection_date, cert_number, cert_exp_date, notes } = req.body;
    db.prepare(`
      UPDATE lead_records SET turnover_date=?, inspection_date=?, cert_number=?, cert_exp_date=?, notes=? WHERE id=?
    `).run(turnover_date || null, inspection_date || null, cert_number || null, cert_exp_date || null, notes || null, req.params.id);
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    db.prepare(`DELETE FROM lead_records WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });

  return router;
};
