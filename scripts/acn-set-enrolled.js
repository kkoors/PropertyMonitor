'use strict';
// One-off: mark the properties the utility has confirmed on the ACN program
// as Enrolled. The list came from the utility with its own spelling quirks —
// hyphens inside street names (Cedar-Crest, St-Fabian), and unit numbers
// written as "*Apt B1" / "*2fl" — so matching is done on a normalised key.
//
//   node scripts/acn-set-enrolled.js          # dry run, prints matches/misses
//   node scripts/acn-set-enrolled.js --apply  # writes the statuses

const path = require('path');
const { createDb, initSchema } = require('../server/db');

const LIST = `
903 Cedar-Crest Ct *Res E
121 MERIDIAN LN
1793 Joan Ave
236 Ridge Ave
3402 Tulleys-Pointe Ct *Apt B1
447 Moores-Mill Rd *Apt 2
5004 Catalpha Rd
7842 St-Fabian Ln
8539 Kavanagh Rd
8323 Dalesford Rd
2007 Bayberry Rd
1427 S Hanover St *2fl
8332 Dalesford Rd
704 St-Peters Ct
7851 St-Fabian Ln
6 Bandon Ct *Apt 202
207 Oak-Leaf Cir *Apt L
612 Silverbell Dr
3505 Roland Ave
8633 Oak Rd
3920 Misty-View Rd
313 Winterberry Dr
8051 Wallace Rd
1307 Bartley Pl
245 Melrose Ct
107 Duryea Dr
221 Ridge Ave
8624 Willow-Oak Rd
1710 Red-Oak Rd
39 Croftley Rd
207 Dawson Dr
2831 Odonnell St *Unit C
120 Royal-Oak Dr *Apt H
1038 Winsford Rd
1721 Red-Oak Rd
1910 Dineen Dr
2511 Edgewood Ave
128 S Newkirk ST
3517 Gough St
8019 Charlesmont Rd
18 Belfast Rd
1303 Cedar-Crest Ct *Apt E
7815 St-Fabian Ln
1427 S Hanover St *1fl
6600 Laurelton Ave
2831 Odonnell St *Unit B
3214 Wallford Dr
3822 Rolling Way
23 Tomahawk Ter
8710 Ashford Rd
1914 Ewald Ave
7990 St-Monica Dr
1280 Gittings Ave
8368 Hillendale Rd
1711 White-Oak Ave
845 W Spring-Meadow Ct
2408 Perry Ave
5517 Weywood Dr
8061 Wallace Rd
7942 St-Monica Dr
8366 Hillendale Rd
1706 Redwood Ave
1321 Gittings Ave
8176 Del-Haven Rd
2109 Pine-Valley Dr
1114 Gittings Ave
`.trim().split('\n').map(s => s.trim()).filter(Boolean);

// Street-type and directional words carry no information for matching and are
// spelled inconsistently on both sides, so they're dropped from the key.
const NOISE = new Set([
  'ST', 'STREET', 'AVE', 'AVENUE', 'RD', 'ROAD', 'DR', 'DRIVE', 'LN', 'LANE',
  'CT', 'COURT', 'CIR', 'CIRCLE', 'PL', 'PLACE', 'TER', 'TERRACE', 'WAY',
  'PKWY', 'PARKWAY', 'LOOP', 'BLVD', 'BOULEVARD', 'LOT', 'LOOPS',
]);
const UNIT_WORDS = /\b(APT|APARTMENT|UNIT|STE|SUITE|RES|FL|FLOOR|BSMT|BASEMENT)\b/g;

// "1427 S Hanover St *2fl" -> { base: '1427SHANOVER', unit: '2' }
// The unit is reduced to its bare alphanumerics ("Apt B1" -> "B1", "2fl" -> "2")
// so "*2fl", "UNIT 2" and "#2" all compare equal.
function key(raw) {
  let s = String(raw || '').toUpperCase();
  s = s.replace(/[.,]/g, ' ');

  let unitPart = '';
  const star = s.indexOf('*');
  if (star >= 0) { unitPart = s.slice(star + 1); s = s.slice(0, star); }
  else {
    const m = s.match(/(?:#|\b(?:APT|APARTMENT|UNIT|STE|SUITE|RES|FL|FLOOR|BSMT)\b)\s*([A-Z0-9-]+)\s*$/);
    if (m) { unitPart = m[0]; s = s.slice(0, m.index); }
  }

  const unit = unitPart
    .replace(UNIT_WORDS, ' ')
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^0+(?=.)/, '');

  const base = s
    .replace(/'/g, '')
    .replace(/\bSAINT\b/g, 'ST')       // ST FABIAN / SAINT FABIAN
    .replace(/\bMOUNT\b/g, 'MT')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    // Keep a leading "ST"/"MT" (Saint Fabian), drop a trailing one (Gough St).
    .filter((w, i, arr) => !(NOISE.has(w) && i === arr.length - 1))
    .filter(w => !NOISE.has(w) || w === 'ST' || w === 'MT')
    .join('');

  return { base, unit, full: base + (unit ? '#' + unit : '') };
}

(async () => {
  const apply = process.argv.includes('--apply');
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'water-bills.db');
  const db = await createDb(dbPath);
  initSchema(db);

  const props = db.prepare(`SELECT id, name, address, acn_status, acn_not_monitored FROM properties`).all();
  const byFull = new Map();
  const byBase = new Map();
  for (const p of props) {
    // Match on either the property name or its street address — the utility's
    // list is closer to one or the other depending on the property.
    for (const src of [p.name, p.address]) {
      const k = key(src);
      if (!k.base) continue;
      if (!byFull.has(k.full)) byFull.set(k.full, p);
      if (!byBase.has(k.base)) byBase.set(k.base, []);
      const arr = byBase.get(k.base);
      if (!arr.includes(p)) arr.push(p);
    }
  }

  const matched = new Map();   // property id -> the line(s) that matched it
  const missed = [];
  const notes = [];

  for (const line of LIST) {
    const k = key(line);
    let hits = [];
    const exact = byFull.get(k.full);
    if (exact) hits = [exact];
    else {
      // We hold most of these as one property per building with no unit in the
      // name, so a listed "*Apt E" still means that property. Where the base
      // covers several rows (1427 S Hanover is held twice, once per floor) they
      // are indistinguishable in the data, so all of them are taken.
      hits = byBase.get(k.base) || [];
      if (hits.length > 1) notes.push(`${line} -> ${hits.length} properties: ${hits.map(h => `#${h.id}`).join(', ')}`);
    }
    if (!hits.length) { missed.push(line); continue; }
    for (const h of hits) {
      if (matched.has(h.id)) {
        notes.push(`${line} -> #${h.id} ${h.name}, already claimed by "${matched.get(h.id)}" (we hold it as one property)`);
      } else matched.set(h.id, line);
    }
  }

  console.log(`${LIST.length} on the utility's list, ${matched.size} properties matched, ${missed.length} not found\n`);

  if (missed.length) {
    console.log('NOT FOUND — no property matches these:');
    for (const m of missed) console.log(`  ${m}   [key ${key(m).full}]`);
    console.log('');
  }
  if (notes.length) {
    console.log('WORTH A LOOK — units on the list vs how we hold the property:');
    for (const n of notes) console.log(`  ${n}`);
    console.log('');
  }

  const flagged = [...matched.keys()]
    .map(id => props.find(p => p.id === id))
    .filter(p => p.acn_not_monitored);
  if (flagged.length) {
    console.log('On the list but flagged "not monitored for ACN" — left alone:');
    for (const p of flagged) console.log(`  #${p.id} ${p.name}`);
    console.log('');
  }

  const toSet = [...matched.keys()].filter(id => {
    const p = props.find(x => x.id === id);
    return !p.acn_not_monitored && p.acn_status !== 'enrolled';
  });

  if (!apply) {
    console.log(`DRY RUN — would set ${toSet.length} properties to Enrolled. Re-run with --apply to write.`);
    for (const id of toSet) {
      const p = props.find(x => x.id === id);
      console.log(`  #${p.id} ${p.name}  (was ${p.acn_status || 'not_enrolled'})   <- "${matched.get(id)}"`);
    }
    return;
  }

  for (const id of toSet) {
    db.prepare(
      `UPDATE properties SET acn_status = 'enrolled', acn_updated_at = datetime('now') WHERE id = ?`
    ).run(id);
  }
  console.log(`Set ${toSet.length} properties to Enrolled.`);
})();
