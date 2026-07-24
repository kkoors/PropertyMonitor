'use strict';
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = require('crypto');

// ── sql.js wrapper (mimics better-sqlite3 sync API) ──────────────────────────

class Statement {
  constructor(dbw, sql) { this._dbw = dbw; this._sql = sql; }
  _bind(args) { return Array.isArray(args[0]) ? args[0] : args; }

  run(...args) {
    const stmt = this._dbw._db.prepare(this._sql);
    stmt.run(this._bind(args));
    stmt.free();
    this._dbw._save();
    const rowid = this._dbw._db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    return { lastInsertRowid: rowid, changes: this._dbw._db.getRowsModified() };
  }

  get(...args) {
    const stmt = this._dbw._db.prepare(this._sql);
    stmt.bind(this._bind(args));
    const row = stmt.step() ? stmt.getAsObject() : undefined;
    stmt.free();
    return row;
  }

  all(...args) {
    const stmt = this._dbw._db.prepare(this._sql);
    stmt.bind(this._bind(args));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
}

class DbWrapper {
  constructor(sqlJsDb, filePath) { this._db = sqlJsDb; this._path = filePath; }
  _save() { fs.writeFileSync(this._path, Buffer.from(this._db.export())); }
  pragma(str) { this._db.run(`PRAGMA ${str}`); }
  exec(sql) { this._db.run(sql); this._save(); return this; }
  prepare(sql) { return new Statement(this, sql); }
}

async function createDb(filePath) {
  const SQL = await initSqlJs();
  const sqlJsDb = fs.existsSync(filePath)
    ? new SQL.Database(fs.readFileSync(filePath))
    : new SQL.Database();
  return new DbWrapper(sqlJsDb, filePath);
}

// ── Schema ────────────────────────────────────────────────────────────────────

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      municipality TEXT NOT NULL,
      account_number TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      private_ws INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      portal TEXT NOT NULL,
      username_enc TEXT,
      password_enc TEXT,
      iv TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      triggered_by TEXT NOT NULL DEFAULT 'scheduler',
      properties_checked INTEGER DEFAULT 0,
      bills_found INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      log TEXT
    );

    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      account_number TEXT,
      bill_date TEXT,
      due_date TEXT,
      amount_due REAL,
      balance_forward REAL,
      current_balance REAL,
      last_pay_date TEXT,
      last_pay_amount REAL,
      period_start TEXT,
      period_end TEXT,
      usage_gallons REAL,
      pdf_path TEXT,
      raw_data TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      scrape_run_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_credentials ON credentials(property_id, portal);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_bills ON bills(property_id, bill_date, amount_due);

    CREATE TABLE IF NOT EXISTS lead_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      turnover_date TEXT,
      inspection_date TEXT,
      cert_number TEXT,
      cert_exp_date TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rental_licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      municipality TEXT NOT NULL,
      license_type TEXT NOT NULL DEFAULT 'rental_license',
      license_number TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      holder_name TEXT,
      issue_date TEXT,
      exp_date TEXT,
      scraped_at TEXT,
      confirmation_letter BLOB,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrations — add columns that may not exist on older DBs
  const cols = db.prepare(`PRAGMA table_info(rental_licenses)`).all().map(c => c.name);
  if (!cols.includes('confirmation_letter')) {
    db.prepare(`ALTER TABLE rental_licenses ADD COLUMN confirmation_letter BLOB`).run();
  }
  if (!cols.includes('unit')) db.prepare(`ALTER TABLE rental_licenses ADD COLUMN unit TEXT DEFAULT ''`).run();

  const leadCols = db.prepare(`PRAGMA table_info(lead_records)`).all().map(c => c.name);
  if (!leadCols.includes('tracking_id')) db.prepare(`ALTER TABLE lead_records ADD COLUMN tracking_id TEXT`).run();
  if (!leadCols.includes('registration_date')) db.prepare(`ALTER TABLE lead_records ADD COLUMN registration_date TEXT`).run();
  if (!leadCols.includes('registration_status')) db.prepare(`ALTER TABLE lead_records ADD COLUMN registration_status TEXT`).run();
  if (!leadCols.includes('cert_status')) db.prepare(`ALTER TABLE lead_records ADD COLUMN cert_status TEXT`).run();
  if (!leadCols.includes('source')) db.prepare(`ALTER TABLE lead_records ADD COLUMN source TEXT`).run();
  if (!leadCols.includes('owner_name')) db.prepare(`ALTER TABLE lead_records ADD COLUMN owner_name TEXT`).run();
  if (!leadCols.includes('owner_address')) db.prepare(`ALTER TABLE lead_records ADD COLUMN owner_address TEXT`).run();
  if (!leadCols.includes('bank_date')) db.prepare(`ALTER TABLE lead_records ADD COLUMN bank_date TEXT`).run();
  if (!leadCols.includes('payment_year')) db.prepare(`ALTER TABLE lead_records ADD COLUMN payment_year INTEGER`).run();

  const ownerCols = db.prepare(`PRAGMA table_info(properties)`).all().map(c => c.name);
  if (!ownerCols.includes('owner_name')) db.prepare(`ALTER TABLE properties ADD COLUMN owner_name TEXT`).run();
  if (!ownerCols.includes('owner_address')) db.prepare(`ALTER TABLE properties ADD COLUMN owner_address TEXT`).run();
  if (!ownerCols.includes('commercial')) db.prepare(`ALTER TABLE properties ADD COLUMN commercial INTEGER NOT NULL DEFAULT 0`).run();
  if (!ownerCols.includes('multifamily')) db.prepare(`ALTER TABLE properties ADD COLUMN multifamily INTEGER NOT NULL DEFAULT 0`).run();
  if (!ownerCols.includes('lead_not_monitored')) db.prepare(`ALTER TABLE properties ADD COLUMN lead_not_monitored INTEGER NOT NULL DEFAULT 0`).run();
  if (!ownerCols.includes('license_not_monitored')) db.prepare(`ALTER TABLE properties ADD COLUMN license_not_monitored INTEGER NOT NULL DEFAULT 0`).run();
  if (!ownerCols.includes('tax_id')) db.prepare(`ALTER TABLE properties ADD COLUMN tax_id TEXT`).run();
  if (!ownerCols.includes('water_mailing_address')) db.prepare(`ALTER TABLE properties ADD COLUMN water_mailing_address TEXT`).run();
  if (!ownerCols.includes('sdat_mailing_address')) db.prepare(`ALTER TABLE properties ADD COLUMN sdat_mailing_address TEXT`).run();
  if (!ownerCols.includes('sdat_checked_at')) db.prepare(`ALTER TABLE properties ADD COLUMN sdat_checked_at TEXT`).run();
  if (!ownerCols.includes('hidden_lead_units')) db.prepare(`ALTER TABLE properties ADD COLUMN hidden_lead_units TEXT`).run();

  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  if (!leadCols.includes('unit')) db.prepare(`ALTER TABLE lead_records ADD COLUMN unit TEXT`).run();
  if (!leadCols.includes('cert_pdf')) db.prepare(`ALTER TABLE lead_records ADD COLUMN cert_pdf BLOB`).run();

  // Migrations for existing databases
  const billCols = db._db.exec(`PRAGMA table_info(bills)`)[0]?.values.map(r => r[1]) || [];
  if (!billCols.includes('current_balance')) db.exec(`ALTER TABLE bills ADD COLUMN current_balance REAL`);
  if (!billCols.includes('last_pay_date'))   db.exec(`ALTER TABLE bills ADD COLUMN last_pay_date TEXT`);
  if (!billCols.includes('last_pay_amount')) db.exec(`ALTER TABLE bills ADD COLUMN last_pay_amount REAL`);

  const propCols = db._db.exec(`PRAGMA table_info(properties)`)[0]?.values.map(r => r[1]) || [];
  if (!propCols.includes('private_ws'))            db.exec(`ALTER TABLE properties ADD COLUMN private_ws INTEGER NOT NULL DEFAULT 0`);
  if (!propCols.includes('year_built'))             db.exec(`ALTER TABLE properties ADD COLUMN year_built INTEGER`);
  if (!propCols.includes('sdat_acct'))              db.exec(`ALTER TABLE properties ADD COLUMN sdat_acct TEXT`);
  if (!propCols.includes('lead_free'))              db.exec(`ALTER TABLE properties ADD COLUMN lead_free INTEGER NOT NULL DEFAULT 0`);
  if (!propCols.includes('lead_free_cert_date'))    db.exec(`ALTER TABLE properties ADD COLUMN lead_free_cert_date TEXT`);
  if (!propCols.includes('lead_free_cert_exp_date')) db.exec(`ALTER TABLE properties ADD COLUMN lead_free_cert_exp_date TEXT`);
}

// ── Encryption ────────────────────────────────────────────────────────────────

const ENC_SECRET = process.env.WATER_BILLS_SECRET || 'dev-secret-change-in-production-32b';
const KEY = scryptSync(ENC_SECRET, 'water-bills-salt', 32);

function encrypt(text) {
  if (!text) return { enc: null, iv: null };
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('hex');
  return { enc, iv: iv.toString('hex') };
}

function decrypt(enc, ivHex) {
  if (!enc || !ivHex) return null;
  const decipher = createDecipheriv('aes-256-cbc', KEY, Buffer.from(ivHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'hex')), decipher.final()]).toString('utf8');
}

module.exports = { createDb, initSchema, encrypt, decrypt };
