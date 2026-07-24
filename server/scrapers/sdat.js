'use strict';

// SDAT website is Cloudflare-protected and blocks headless browsers.
// We use municipality-specific open data APIs instead.

const COUNTY_CODES = {
  baltimore_city:   '03',
  baltimore_county: '02',
  harford:          '13',
};

function parseAddress(address) {
  const street = address.split(',')[0].trim();
  const match = street.match(/^(\d+)\s+(.+)$/);
  if (!match) return null;
  const full = match[2].trim();
  const nameOnly = full.replace(/\s+(ST|AVE|DR|RD|LN|CT|PL|WAY|BLVD|CIR|TER|TRL|PKWY|SQ|SQUARE|HWY|RTE|RT)\s*$/i, '').trim();
  return { number: match[1], name: full, nameOnly };
}

async function lookupSdat(property) {
  const countyCode = COUNTY_CODES[property.municipality];
  if (!countyCode) return { error: `No county code for: ${property.municipality}` };

  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  // Route to the right open-data API by municipality
  if (property.municipality === 'baltimore_city') {
    return lookupBaltimoreCity(parsed);
  } else if (property.municipality === 'baltimore_county') {
    return lookupBaltimoreCounty(parsed);
  } else if (property.municipality === 'harford') {
    return lookupHarford(parsed, countyCode);
  }
  return { error: `No year-built lookup implemented for: ${property.municipality}` };
}

// ── Baltimore City ──────────────────────────────────────────────────────────
// Open Baltimore has a Real Property dataset with year_build field
async function lookupBaltimoreCity(parsed) {
  // Discover the right dataset via Socrata catalog
  try {
    const catalogRes = await fetch(
      `https://data.baltimorecity.gov/api/catalog/v1?q=real+property&limit=10`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (catalogRes.ok) {
      const catalog = await catalogRes.json();
      const datasets = catalog.results || [];
      console.log('[sdat-city] catalog datasets:', datasets.map(d => `${d.resource?.id} — ${d.resource?.name}`).join('\n  '));

      for (const ds of datasets) {
        const id = ds.resource?.id;
        if (!id) continue;
        const name = (ds.resource?.name || '').toLowerCase();
        if (!name.includes('real property') && !name.includes('assessment') && !name.includes('tax')) continue;

        const result = await queryCityDataset(id, parsed);
        if (result && !result.error) return result;
      }
    }
  } catch (err) {
    console.log('[sdat-city] catalog error:', err.message);
  }

  // Fallback: try known dataset IDs for Baltimore City real property
  const knownIds = ['27w9-urtv', 'yi87-8hs7', 'mgsc-e6h8', '7j8r-9fde', 'dz54-2aru'];
  for (const id of knownIds) {
    const result = await queryCityDataset(id, parsed);
    if (result && !result.error) return result;
  }

  return { error: 'Baltimore City year-built lookup: no matching dataset found. Enter year built manually in Properties.' };
}

async function queryCityDataset(datasetId, parsed) {
  const url = `https://data.baltimorecity.gov/resource/${datasetId}.json`;
  try {
    // Probe: get one record to see column names
    const probe = await fetch(`${url}?$limit=1`, { signal: AbortSignal.timeout(8000) });
    if (!probe.ok) return null;
    const sample = await probe.json();
    if (!Array.isArray(sample) || sample.length === 0) return null;

    const cols = Object.keys(sample[0]);
    console.log(`[sdat-city] dataset ${datasetId} cols:`, cols.join(', '));

    // Find house number and street name columns
    const numCol  = cols.find(c => /house|bldg|premise|street.*no|^no$/i.test(c));
    const nameCol = cols.find(c => /street.*name|st_name|streetname/i.test(c));
    const yearCol = cols.find(c => /year.*bu|yr.*bu|yrblt|yearblt/i.test(c));

    if (!numCol || !nameCol || !yearCol) {
      console.log(`[sdat-city] dataset ${datasetId}: missing required cols (num=${numCol} name=${nameCol} year=${yearCol})`);
      return null;
    }

    const q = new URLSearchParams({
      $where: `${numCol}='${parsed.number}'`,
      $limit: '20',
    });
    const res = await fetch(`${url}?${q}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const rows = await res.json();
    console.log(`[sdat-city] dataset ${datasetId}: ${rows.length} rows for house# ${parsed.number}`);
    if (rows.length === 0) return null;

    // Match street name
    const row = rows.find(r => {
      const sn = (r[nameCol] || '').toUpperCase();
      return sn.includes(parsed.nameOnly.toUpperCase()) || parsed.nameOnly.toUpperCase().includes(sn);
    }) || rows[0];

    const yearBuilt = row[yearCol] ? Number(row[yearCol]) : null;
    if (!yearBuilt || isNaN(yearBuilt)) return null;

    return { year_built: yearBuilt, sdat_acct: row.acctno || row.account_no || row.parcel_id || null };
  } catch (err) {
    console.log(`[sdat-city] dataset ${datasetId} error: ${err.message}`);
    return null;
  }
}

// ── Baltimore County ────────────────────────────────────────────────────────
// Discover ArcGIS services on the county server, then query the best one for year_built.
const BC_ARCGIS = 'https://bcgisapps.baltimorecountymd.gov/arcgis/rest/services';

async function lookupBaltimoreCounty(parsed) {
  // Step 1: check if the rental license service already has year_built
  const rlResult = await queryBCLayer(
    `${BC_ARCGIS}/RentalLicense/MapServer/0/query`, parsed,
    [`B1_HSE_NBR_START=${parsed.number}`, `UPPER(B1_STR_NAME) LIKE '${parsed.nameOnly.replace(/'/g, "''").toUpperCase()}%'`]
  );
  if (rlResult) return rlResult;

  // Step 2: discover all MapServer services and try ones that sound like property/parcel data
  let serviceNames = [];
  try {
    const dir = await fetch(`${BC_ARCGIS}?f=json`, { signal: AbortSignal.timeout(10000) });
    if (dir.ok) {
      const data = await dir.json();
      const all = [
        ...(data.services || []),
        ...((data.folders || []).map(f => ({ name: f, type: 'folder' }))),
      ];
      console.log('[sdat-county] ArcGIS services:', all.map(s => s.name).join(', '));
      serviceNames = all
        .filter(s => s.type !== 'folder' && /parcel|property|assess|real.*prop|land|tax/i.test(s.name))
        .map(s => s.name);
      console.log('[sdat-county] candidate services:', serviceNames.join(', '));
    }
  } catch (err) {
    console.log('[sdat-county] services directory error:', err.message);
  }

  // Also try folders
  const folders = ['Parcels', 'Property', 'Assessment', 'RealProperty', 'Land'];
  for (const folder of folders) {
    try {
      const res = await fetch(`${BC_ARCGIS}/${folder}?f=json`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const svcs = (data.services || []).map(s => s.name);
        console.log(`[sdat-county] folder ${folder}:`, svcs.join(', '));
        serviceNames.push(...svcs.filter(n => /parcel|property|assess|real.*prop|land|tax/i.test(n)));
      }
    } catch { /* ignore */ }
  }

  // Step 3: query each candidate service (try layers 0 and 1)
  for (const name of [...new Set(serviceNames)]) {
    for (const layer of [0, 1, 2]) {
      const base = `${BC_ARCGIS}/${name}/MapServer/${layer}/query`;
      const result = await queryBCLayer(base, parsed);
      if (result) return result;
    }
  }

  return { error: 'Baltimore County year-built: no matching ArcGIS layer found. Check pm2 logs for available services, or enter year built manually.' };
}

async function queryBCLayer(url, parsed, extraWhere) {
  // Try multiple field name patterns for house number and street
  const whereClauses = extraWhere || [
    `HSE_NBR=${parsed.number}`,
    `HOUSE_NO=${parsed.number}`,
    `HSENUMBER=${parsed.number}`,
    `ADDR_NO=${parsed.number}`,
  ];

  for (const where of whereClauses) {
    try {
      const params = new URLSearchParams({ where, outFields: '*', f: 'json', resultRecordCount: '10' });
      const res = await fetch(`${url}?${params}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.error) return null;

      const features = data.features || [];
      if (features.length === 0) continue;

      const f = features[0].attributes;
      const cols = Object.keys(f);
      console.log(`[sdat-county] ${url} (where: ${where}): ${features.length} features, fields: ${cols.join(', ')}`);

      const yearCol = cols.find(k => /year.*bu|yr.*bu|yrblt|yearblt/i.test(k));
      const yearBuilt = yearCol ? Number(f[yearCol]) : null;
      if (!yearBuilt || isNaN(yearBuilt) || yearBuilt < 1700 || yearBuilt > 2030) return null;

      console.log(`[sdat-county] Found year_built=${yearBuilt} via ${yearCol} in ${url}`);
      const acctCol = cols.find(k => /acct|parcel.*id|pin/i.test(k));
      return { year_built: yearBuilt, sdat_acct: acctCol ? f[acctCol] : null };
    } catch (err) {
      console.log(`[sdat-county] ${url} error: ${err.message}`);
      return null;
    }
  }
  return null;
}

// ── Harford County ──────────────────────────────────────────────────────────
async function lookupHarford(parsed, countyCode) {
  // Try Maryland Open Data for Harford assessment records
  try {
    const catalog = await fetch(
      `https://data.maryland.gov/api/catalog/v1?q=harford+real+property&limit=5`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (catalog.ok) {
      const cat = await catalog.json();
      console.log('[sdat-harford] MD catalog:', (cat.results || []).map(d => `${d.resource?.id} — ${d.resource?.name}`).join('\n  '));
    }
  } catch (err) {
    console.log('[sdat-harford] catalog error:', err.message);
  }

  return { error: 'Harford County year-built lookup not yet available. Enter year built manually in Properties.' };
}

module.exports = { lookupSdat };
