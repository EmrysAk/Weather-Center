// Place name → coordinates. Open-Meteo's geocoder is keyless and global;
// "lat,lon" strings and US ZIP codes resolve too. Results cached a day.

const { fetchJson, cached } = require('../fetch');
const { parseLatLon } = require('../geo');

const DAY = 24 * 3600 * 1000;

function normalize(r) {
  return {
    name: r.name,
    admin1: r.admin1 || null,          // state / province
    country: r.country || null,
    country_code: r.country_code || null,
    lat: r.latitude,
    lon: r.longitude,
    elevation_m: r.elevation ?? null,
    population: r.population ?? null,
    timezone: r.timezone || null,
    label: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '),
  };
}

async function geocode(q, count = 6) {
  const direct = parseLatLon(q);
  if (direct) return [{ name: `${direct.lat.toFixed(3)}, ${direct.lon.toFixed(3)}`, admin1: null, country: null, country_code: null, lat: direct.lat, lon: direct.lon, label: `${direct.lat.toFixed(3)}, ${direct.lon.toFixed(3)}`, timezone: null }];
  const name = String(q || '').trim();
  if (!name) return [];
  const key = `geocode:${name.toLowerCase()}:${count}`;
  const { data } = await cached(key, DAY, async () => {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=${count}&language=en&format=json`;
    const j = await fetchJson(url, { source: 'open-meteo-geocode' });
    return (j.results || []).map(normalize);
  });
  return data;
}

// First match, US-biased when the query is ambiguous (a US weather center's
// operators type "Springfield" meaning the American one).
async function resolve(q) {
  const hits = await geocode(q, 8);
  if (!hits.length) return null;
  const us = hits.find(h => h.country_code === 'US');
  return us && hits.indexOf(us) <= 2 ? us : hits[0];
}

module.exports = { geocode, resolve };
