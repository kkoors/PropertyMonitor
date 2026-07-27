'use strict';
const { Router } = require('express');

module.exports = function makeBillsRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const { property_id, status, limit = 100 } = req.query;
    // Owner-paid water is not our responsibility, so those bills stay off the
    // water pages entirely (?all=1 shows them anyway).
    let query = `
      SELECT b.*, p.name as property_name, p.municipality
      FROM bills b
      JOIN properties p ON p.id = b.property_id
      WHERE 1=1
      ${req.query.all === '1' ? '' : `AND COALESCE(p.water_responsibility, 'management') <> 'owner'`}
    `;
    const params = [];
    if (property_id) { query += ' AND b.property_id = ?'; params.push(property_id); }
    if (status) { query += ' AND b.status = ?'; params.push(status); }
    query += ' ORDER BY b.created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    res.json(db.prepare(query).all(...params));
  });

  router.patch('/:id/status', (req, res) => {
    const { status } = req.body;
    const valid = ['new', 'reviewed', 'entered', 'paid'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    db.prepare(`UPDATE bills SET status = ? WHERE id = ?`).run(status, req.params.id);
    res.json({ ok: true });
  });

  return router;
};
