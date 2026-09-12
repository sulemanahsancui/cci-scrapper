/**
 * City lists for regions that cannot use the dropdown (ILE-DE-FRANCE, OCCITANIE).
 * Source CSV: data/cities/city-search.csv  (columns: region,city)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV = path.resolve(__dirname, '../../data/cities/city-search.csv');

/** Regions scraped via ?city= instead of the region dropdown */
export const CITY_SEARCH_REGION_KEYS = ['ILE-DE-FRANCE', 'OCCITANIE'];

export function normalizeRegionKey(label) {
  return String(label || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .trim();
}

export function isCitySearchRegion(label) {
  const key = normalizeRegionKey(label);
  return CITY_SEARCH_REGION_KEYS.some(
    (r) => key.includes(r) || r.includes(key),
  );
}

/** Turn "Montpellier" / "Boulogne-Billancourt" into URL query value */
export function cityToQuery(city) {
  return String(city || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function citySearchUrl(city, baseUrl = 'https://www.cci.fr/agent-immobilier') {
  const q = cityToQuery(city);
  return `${baseUrl}?city=${encodeURIComponent(q)}`;
}

/**
 * @returns {Promise<Record<string, string[]>>} e.g. { 'ILE-DE-FRANCE': ['Paris', ...], ... }
 */
export async function loadCitySearchLists(csvPath = DEFAULT_CSV) {
  const text = await fs.readFile(csvPath, 'utf8');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return {};

  const header = lines[0].toLowerCase().split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const regionIdx = header.indexOf('region');
  const cityIdx = header.indexOf('city');
  if (regionIdx < 0 || cityIdx < 0) {
    throw new Error(`city-search.csv must have region,city columns (got: ${header.join(',')})`);
  }

  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const region = normalizeRegionKey(cols[regionIdx] || '');
    const city = (cols[cityIdx] || '').trim();
    if (!region || !city || city.toLowerCase() === 'city') continue;
    if (!out[region]) out[region] = [];
    out[region].push(city);
  }

  // de-dupe preserving order
  for (const key of Object.keys(out)) {
    const seen = new Set();
    out[key] = out[key].filter((c) => {
      const s = cityToQuery(c);
      if (!s || seen.has(s)) return false;
      seen.add(s);
      return true;
    });
  }

  return out;
}

export async function citiesForRegion(regionLabel, csvPath = DEFAULT_CSV) {
  const lists = await loadCitySearchLists(csvPath);
  const key = normalizeRegionKey(regionLabel);
  // exact or partial match on keys
  if (lists[key]) return lists[key];
  for (const [k, cities] of Object.entries(lists)) {
    if (key.includes(k) || k.includes(key)) return cities;
  }
  return [];
}

/**
 * Split a city list across fleet instances.
 * Contiguous shards: { of: 2, index: 0 } → first half, { of: 2, index: 1 } → second half.
 * Optional untilCity (inclusive) / afterCity (exclusive) trim the shard further.
 */
export function applyCityShard(cities, shard) {
  if (!shard || cities == null) return cities || [];
  let list = [...cities];

  const of = Number(shard.of ?? 1);
  const index = Number(shard.index ?? 0);
  if (!Number.isFinite(of) || of < 1) {
    throw new Error(`Invalid cityShard.of: ${JSON.stringify(shard)}`);
  }
  if (!Number.isFinite(index) || index < 0 || index >= of) {
    throw new Error(`Invalid cityShard.index: ${JSON.stringify(shard)}`);
  }
  if (of > 1) {
    const n = list.length;
    const start = Math.floor((n * index) / of);
    const end = Math.floor((n * (index + 1)) / of);
    list = list.slice(start, end);
  }

  if (shard.untilCity) {
    const needle = cityToQuery(shard.untilCity);
    const idx = list.findIndex((c) => cityToQuery(c) === needle);
    if (idx >= 0) list = list.slice(0, idx + 1);
  }
  if (shard.afterCity) {
    const needle = cityToQuery(shard.afterCity);
    const idx = list.findIndex((c) => cityToQuery(c) === needle);
    list = idx >= 0 ? list.slice(idx + 1) : [];
  }

  return list;
}

function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      out.push(field.trim());
      field = '';
    } else {
      field += c;
    }
  }
  out.push(field.trim());
  return out;
}

export default {
  CITY_SEARCH_REGION_KEYS,
  normalizeRegionKey,
  isCitySearchRegion,
  cityToQuery,
  citySearchUrl,
  loadCitySearchLists,
  citiesForRegion,
  applyCityShard,
};
