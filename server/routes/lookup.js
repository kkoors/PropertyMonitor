'use strict';
const { Router } = require('express');

const FIPS_MAP = {
  '24510': 'baltimore_city',
  '24005': 'baltimore_county',
  '24025': 'harford',
};

const MUNI_LABELS = {
  baltimore_city:   'Baltimore City',
  baltimore_county: 'Baltimore County',
  harford:          'Harford County',
};

const COUNTY_NAMES = {
  '24510': 'Baltimore City',
  '24005': 'Baltimore County',
  '24025': 'Harford County',
};

async function geocodeAddress(address) {
  const url = new URL('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress');
  url.searchParams.set('address', address);
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('vintage', 'Current_Current');
  url.searchParams.set('layers', '10');
  url.searchParams.set('format', 'json');

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Census API error: ${res.status}`);
  const data = await res.json();

  const matches = data.result?.addressMatches;
  if (!matches || matches.length === 0) return { matched: false };

  const match = matches[0];
  const geo = match.geographies || {};
  const blockGroup = (geo['Census Block Groups'] || [])[0];
  const fips = blockGroup ? (blockGroup.STATE + blockGroup.COUNTY) : null;
  const municipality = FIPS_MAP[fips] || null;

  return {
    matched: true,
    matched_address: match.matchedAddress,
    municipality,
    municipality_label: municipality ? MUNI_LABELS[municipality] : null,
    supported: !!municipality,
    county_name: fips ? (COUNTY_NAMES[fips] || `County FIPS ${fips}`) : null,
    state: match.addressComponents?.state || null,
    coordinates: match.coordinates || null,
  };
}

// The Census geocoder is the slow part — about a second per address — so a
// long list is worked a few at a time rather than strictly one after another.
// The client still sends in batches, so this cap is a backstop, not the limit
// on how many addresses you can paste in.
const MAX_PER_REQUEST = 100;
const CONCURRENCY = 5;

// Runs the mapper over the list a few at a time, keeping the results in the
// order they were given.
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

function normalizeAddress(addr) {
  return (addr || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

module.exports = function makeLookupRouter(db) {
  const router = Router();

  router.post('/', async (req, res) => {
    const { addresses } = req.body;
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({ error: 'addresses array required' });
    }
    if (addresses.length > MAX_PER_REQUEST) {
      return res.status(400).json({ error: `Max ${MAX_PER_REQUEST} addresses per request` });
    }

    // Load existing properties once for duplicate checking
    const existing = db.prepare(`SELECT id, name, address FROM properties`).all();

    const wanted = addresses.map(a => String(a || '').trim()).filter(Boolean);

    const results = await mapWithConcurrency(wanted, CONCURRENCY, async trimmed => {
      try {
        const result = await geocodeAddress(trimmed);

        // Check for duplicates against both the input and the Census-normalized address
        const candidateAddresses = [normalizeAddress(trimmed)];
        if (result.matched_address) candidateAddresses.push(normalizeAddress(result.matched_address));

        const duplicate = existing.find(p =>
          candidateAddresses.includes(normalizeAddress(p.address))
        );

        return {
          input: trimmed,
          ...result,
          duplicate: duplicate ? { id: duplicate.id, name: duplicate.name, address: duplicate.address } : null,
        };
      } catch (err) {
        return { input: trimmed, matched: false, error: err.message, duplicate: null };
      }
    });

    res.json(results);
  });

  return router;
};
