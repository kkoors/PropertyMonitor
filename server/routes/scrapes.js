'use strict';
const { Router } = require('express');

module.exports = function makeScrapesRouter(db, runAllScrapers, runOneProperty) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(db.prepare(`SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT 50`).all());
  });

  router.get('/:id', (req, res) => {
    const run = db.prepare(`SELECT * FROM scrape_runs WHERE id = ?`).get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    res.json(run);
  });

  router.post('/run', (req, res) => {
    res.json({ message: 'Scrape started' });
    runAllScrapers('manual').catch(err => console.error('[scrape] error:', err));
  });

  router.post('/run/:propertyId', (req, res) => {
    res.json({ message: 'Scrape started' });
    runOneProperty(req.params.propertyId)
      .then(r => console.log('[scrape] done:', JSON.stringify(r)))
      .catch(err => console.error('[scrape] error:', err));
  });

  return router;
};
