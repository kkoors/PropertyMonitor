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
// Tax Parcel layer in LAW_LANDAQ has ST_NUM, STREETNAME, YEAR_BUILT
const BC_TAX_PARCEL = 'https://bcgisapps.baltimorecountymd.gov/arcgis/rest/services/AgencyMaps/LAW_LANDAQ/MapServer/257/query';

async function lookupBaltimoreCounty(parsed) {
  const streetName = parsed.nameOnly.replace(/'/g, "''").toUpperCase();
  const where = `ST_NUM='${parsed.number}' AND UPPER(STREETNAME) LIKE '${streetName}%'`;
  const params = new URLSearchParams({ where, outFields: 'ST_NUM,STREETNAME,YEAR_BUILT,TAXPIN,PIN', f: 'json', resultRecordCount: '5' });

  try {
    const res = await fetch(`${BC_TAX_PARCEL}?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { error: `Baltimore County Tax Parcel HTTP ${res.status}` };
    const data = await res.json();
    if (data.error) return { error: `Baltimore County Tax Parcel: ${data.error.message}` };

    const features = data.features || [];
    console.log(`[sdat-county] Tax Parcel: ${features.length} features for ST_NUM=${parsed.number} STREETNAME like '${streetName}%'`);
    if (features.length === 0) {
      return { error: 'Baltimore County year-built: address not found in Tax Parcel layer. Enter year built manually.' };
    }

    const f = features[0].attributes;
    const yearBuilt = f.YEAR_BUILT ? Number(f.YEAR_BUILT) : null;
    if (!yearBuilt || isNaN(yearBuilt) || yearBuilt < 1700 || yearBuilt > 2030) {
      return { error: 'Baltimore County year-built: no year built value in Tax Parcel record. Enter manually.' };
    }

    console.log(`[sdat-county] Found YEAR_BUILT=${yearBuilt} TAXPIN=${f.TAXPIN}`);
    return { year_built: yearBuilt, sdat_acct: f.TAXPIN || f.PIN || null };
  } catch (err) {
    return { error: `Baltimore County Tax Parcel error: ${err.message}` };
  }
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
