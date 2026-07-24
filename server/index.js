'use strict';
// env vars come from PM2 ecosystem.config.js + pm2 env set for secrets
const express = require('express');
const { sessionMiddleware, requireAuth, authRoutes } = require('./auth');
const path = require('path');
const cron = require('node-cron');
const { createDb, initSchema } = require('./db');
const makePropertiesRouter = require('./routes/properties');
const makeBillsRouter = require('./routes/bills');
const makeScrapesRouter = require('./routes/scrapes');
const { makeRunScrapers, makeRunOne } = require('./scrapers/index');
const lookupRouter = require('./routes/lookup');
const makeEmailRouter = require('./routes/email');
const makeLeadRouter = require('./routes/lead');
const makeRentalLicensesRouter = require('./routes/rentalLicenses');
const makeComplianceRouter = require('./routes/compliance');

const PORT = process.env.PORT || 3401;

async function start() {
  const db = await createDb(path.join(__dirname, '..', 'water-bills.db'));
  initSchema(db);

  const runAllScrapers = makeRunScrapers(db);
  const runOneProperty = makeRunOne(db);

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '5mb' })); // logo uploads come through as base64 JSON
  app.use(express.urlencoded({ extended: false }));
  app.use(sessionMiddleware());
  authRoutes(app);
  app.use(requireAuth);
  app.use('/bills', express.static(path.join(__dirname, '..', 'bills')));

  app.use('/api/properties', makePropertiesRouter(db));
  app.use('/api/bills', makeBillsRouter(db));
  app.use('/api/scrapes', makeScrapesRouter(db, runAllScrapers, runOneProperty));
  app.use('/api/lookup', lookupRouter(db));
  app.use('/api/email', makeEmailRouter(db));
  app.use('/api/lead', makeLeadRouter(db));
  app.use('/api/rental-licenses', makeRentalLicensesRouter(db));
  app.use('/api/compliance', makeComplianceRouter(db));
  app.use('/api/settings', require('./routes/settings')(db));
  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '..', 'dist')));
    app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'dist', 'index.html')));
  }

  app.listen(PORT, () => console.log(`Water Bills server → http://localhost:${PORT}`));

  // Daily scrape at 7am
  cron.schedule('0 7 * * *', () => {
    console.log('[cron] Running daily water bill scrape');
    runAllScrapers('scheduler').catch(err => console.error('[cron] error:', err));
  });
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
