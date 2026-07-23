'use strict';

const BASE = 'https://hcgweb01.harfordcountymd.gov/billpay';

const tests = [
  '20 NORTH FOREST',
  '20 N FOREST',
  '3402 TULLEYS POINTE',
  '3402 TULLEYS POINT',
  '3402 TULLEYS',
];

async function test(street) {
  const url = `${BASE}/Search/ByAddress?Address=${encodeURIComponent(street)}`;
  const html = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text());
  const link = html.match(/href="(\/billpay\/Account\/Detail\?[^"]+)"/i);
  console.log(`"${street}" → ${link ? link[1] : 'NO RESULT'}`);
}

(async () => { for (const t of tests) await test(t); })().catch(console.error);
