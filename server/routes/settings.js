'use strict';
const { Router } = require('express');

const ALLOWED_KEYS = new Set(['app_name', 'primary_color', 'sidebar_color', 'logo']);

module.exports = function makeSettingsRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const rows = db.prepare(`SELECT key, value FROM settings`).all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    res.json(out);
  });

  router.put('/', (req, res) => {
    for (const [key, value] of Object.entries(req.body || {})) {
      if (!ALLOWED_KEYS.has(key)) continue;
      db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
      if (value != null && value !== '') {
        db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(key, String(value));
      }
    }
    res.json({ ok: true });
  });

  return router;
};
