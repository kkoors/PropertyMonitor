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
// City GIS real property layer: geodata.baltimorecity.gov (BLDG_NO, ST_NAME, YEAR_BUILD)
const BCITY_REALPROP = 'https://geodata.baltimorecity.gov/egis/rest/services/CityView/Realproperty_OB/MapServer/0/query';

async function lookupBaltimoreCity(parsed) {
  const streetName = parsed.nameOnly.replace(/'/g, "''").toUpperCase();
  const where = `BLDG_NO='${parsed.number}' AND UPPER(ST_NAME) LIKE '${streetName}%'`;
  const params = new URLSearchParams({ where, outFields: 'BLDG_NO,ST_NAME,YEAR_BUILD,BLOCKLOT,PIN', f: 'json', resultRecordCount: '5' });

  try {
    const res = await fetch(`${BCITY_REALPROP}?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { error: `Baltimore City Real Property HTTP ${res.status}` };
    const data = await res.json();
    if (data.error) return { error: `Baltimore City Real Property: ${data.error.message}` };

    const features = data.features || [];
    console.log(`[sdat-city] Real Property: ${features.length} features for BLDG_NO='${parsed.number}' ST_NAME like '${streetName}%'`);
    if (features.length === 0) {
      return { error: 'Baltimore City year-built: address not found in Real Property layer. Enter year built manually.' };
    }

    const f = features[0].attributes;
    const yearBuilt = f.YEAR_BUILD ? Number(f.YEAR_BUILD) : null;
    if (!yearBuilt || isNaN(yearBuilt) || yearBuilt < 1700 || yearBuilt > 2030) {
      return { error: 'Baltimore City year-built: no year built value in Real Property record. Enter manually.' };
    }

    console.log(`[sdat-city] Found YEAR_BUILD=${yearBuilt} BLOCKLOT=${f.BLOCKLOT}`);
    return { year_built: yearBuilt, sdat_acct: f.BLOCKLOT || f.PIN || null };
  } catch (err) {
    return { error: `Baltimore City Real Property error: ${err.message}` };
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
// Harford County GIS Cadastral layer: P_ST_NO (Double), P_ST_NAME, YR_BUILT
const HC_CADASTRAL = 'https://hcggis.harfordcountymd.gov/public/rest/services/Planning/Cadastral/MapServer/0/query';

async function lookupHarford(parsed) {
  const streetName = parsed.nameOnly.replace(/'/g, "''").toUpperCase();
  const where = `P_ST_NO=${parsed.number} AND UPPER(P_ST_NAME) LIKE '${streetName}%'`;
  const params = new URLSearchParams({ where, outFields: 'P_ST_NO,P_ST_NAME,YR_BUILT,FEATURE', f: 'json', resultRecordCount: '5' });

  try {
    const res = await fetch(`${HC_CADASTRAL}?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { error: `Harford Cadastral HTTP ${res.status}` };
    const data = await res.json();
    if (data.error) return { error: `Harford Cadastral: ${data.error.message}` };

    const features = data.features || [];
    console.log(`[sdat-harford] Cadastral: ${features.length} features for P_ST_NO=${parsed.number} P_ST_NAME like '${streetName}%'`);
    if (features.length === 0) {
      return { error: 'Harford County year-built: address not found in Cadastral layer. Enter year built manually.' };
    }

    const f = features[0].attributes;
    const yearBuilt = f.YR_BUILT ? Number(f.YR_BUILT) : null;
    if (!yearBuilt || isNaN(yearBuilt) || yearBuilt < 1700 || yearBuilt > 2030) {
      return { error: 'Harford County year-built: no year built value in Cadastral record. Enter manually.' };
    }

    console.log(`[sdat-harford] Found YR_BUILT=${yearBuilt} FEATURE=${f.FEATURE}`);
    return { year_built: yearBuilt, sdat_acct: f.FEATURE || null };
  } catch (err) {
    return { error: `Harford Cadastral error: ${err.message}` };
  }
}

// ── Statewide: SDAT owner mailing address via MD iMAP parcel layer ──────────
const MD_PARCELS = 'https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_PropertyData/MapServer/0/query';
const JURSCODES = {
  baltimore_city:   'BACI',
  baltimore_county: 'BACO',
  harford:          'HARF',
};

async function lookupSdatMailing(property) {
  const jurs = JURSCODES[property.municipality];
  if (!jurs) return { error: `No jurisdiction code for: ${property.municipality}` };

  const parsed = parseAddress(property.address);
  if (!parsed) return { error: `Could not parse address: ${property.address}` };

  const streetName = parsed.nameOnly.replace(/'/g, "''").toUpperCase();
  const where = `JURSCODE='${jurs}' AND PREMSNUM='${parsed.number}' AND UPPER(PREMSNAM) LIKE '${streetName}%'`;
  const params = new URLSearchParams({
    where,
    outFields: 'ACCTID,OWNADD1,OWNADD2,OWNCITY,OWNSTATE,OWNERZIP,ADDRESS,PREMSNAM',
    f: 'json',
    resultRecordCount: '5',
  });

  try {
    const res = await fetch(`${MD_PARCELS}?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { error: `MD parcel service HTTP ${res.status}` };
    const data = await res.json();
    if (data.error) return { error: `MD parcel service: ${data.error.message}` };

    const features = data.features || [];
    console.log(`[sdat-mailing] ${features.length} parcels for ${jurs} ${parsed.number} ${streetName}%`);
    if (features.length === 0) {
      return { error: 'SDAT mailing lookup: address not found in MD parcel data.' };
    }

    const f = features[0].attributes;
    const mailing = [
      [f.OWNADD1, f.OWNADD2].filter(Boolean).join(' ').trim(),
      [f.OWNCITY, f.OWNSTATE].filter(Boolean).join(', '),
      f.OWNERZIP || '',
    ].filter(Boolean).join(', ').replace(/\s+/g, ' ').trim();

    return {
      tax_id: f.ACCTID || null,
      mailing_address: mailing || null,
      parcel_address: f.ADDRESS || null,
    };
  } catch (err) {
    return { error: `SDAT mailing lookup error: ${err.message}` };
  }
}

module.exports = { lookupSdat, lookupSdatMailing };
