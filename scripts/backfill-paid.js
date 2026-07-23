'use strict';
const path = require('path');
const { createDb, initSchema } = require('../server/db');

async function main() {
  const db = await createDb(path.join(__dirname, '..', 'water-bills.db'));
  initSchema(db);

  const bills = db.prepare(`SELECT id, amount_due, status FROM bills`).all();
  console.log('All bills:', bills);

  const result = db.prepare(
    `UPDATE bills SET status = 'paid' WHERE amount_due <= 0 AND status = 'new'`
  ).run();
  console.log(`Updated ${result.changes} bill(s) to status 'paid'.`);
}

main().catch(e => { console.error(e); process.exit(1); });
