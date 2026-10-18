// Aviation weather — METARs and TAFs from aviationweather.gov (keyless).
// Airports are the densest, most reliable observation network there is, so
// the nearest few also serve as "what is it doing right now" ground truth.

const { fetchJson, cached } = require('../fetch');

const MIN = 60 * 1000;
const BASE = 'https://aviationweather.gov/api/data';

const flightCategory = (m) => m.fltCat || null;

function normalizeMetar(m) {
  return {
    station: m.icaoId, name: m.name || null, time: m.reportTime || (m.obsTime ? new Date(m.obsTime * 1000).toISOString() : null), raw: m.rawOb,
    temp_c: m.temp ?? null, dewpoint_c: m.dewp ?? null, wind_dir: m.wdir ?? null, wind_kt: m.wspd ?? null, gust_kt: m.wgst ?? null,
    visibility_sm: m.visib ?? null, altimeter_hpa: m.altim ?? null, slp_hpa: m.slp ?? null, flight_category: flightCategory(m),
    clouds: (m.clouds || []).map(c => ({ cover: c.cover, base_ft: c.base })), wx: m.wxString || null, lat: m.lat, lon: m.lon, elev_m: m.elev,
  };
}

async function metar(ids) {
  const list = String(ids || '').toUpperCase().split(/[,\s]+/).filter(s => /^[A-Z0-9]{3,4}$/.test(s)).slice(0, 20);
  if (!list.length) return { stations: [] };
  const { data, fetched_at, stale, error } = await cached(`metar:${list.join(',')}`, 5 * MIN, async () => {
    const j = await fetchJson(`${BASE}/metar?ids=${list.join(',')}&format=json&taf=false`, { source: 'aviationweather' });
    return (Array.isArray(j) ? j : []).map(normalizeMetar);
  }, { staleMs: 60 * MIN });
  return { fetched_at, stale, error, stations: data };
}

async function taf(ids) {
  const list = String(ids || '').toUpperCase().split(/[,\s]+/).filter(s => /^[A-Z0-9]{3,4}$/.test(s)).slice(0, 10);
  if (!list.length) return { tafs: [] };
  const { data, fetched_at, stale, error } = await cached(`taf:${list.join(',')}`, 15 * MIN, async () => {
    const j = await fetchJson(`${BASE}/taf?ids=${list.join(',')}&format=json`, { source: 'aviationweather' });
    return (Array.isArray(j) ? j : []).map(t => ({ station: t.icaoId, issue: t.issueTime, valid_from: t.validTimeFrom ? new Date(t.validTimeFrom * 1000).toISOString() : null, valid_to: t.validTimeTo ? new Date(t.validTimeTo * 1000).toISOString() : null, raw: t.rawTAF }));
  }, { staleMs: 60 * MIN });
  return { fetched_at, stale, error, tafs: data };
}

// METARs within a bounding box around a point (nearest airports).
async function nearby(lat, lon, radiusDeg = 1.0) {
  const bbox = [lat - radiusDeg, lon - radiusDeg, lat + radiusDeg, lon + radiusDeg].map(v => v.toFixed(2)).join(',');
  const { data, fetched_at, stale, error } = await cached(`metar:bbox:${bbox}`, 5 * MIN, async () => {
    const j = await fetchJson(`${BASE}/metar?bbox=${bbox}&format=json`, { source: 'aviationweather' });
    return (Array.isArray(j) ? j : []).map(normalizeMetar);
  }, { staleMs: 60 * MIN });
  const { nearest } = require('../geo');
  return { fetched_at, stale, error, stations: nearest(data, lat, lon, 6).map(x => ({ ...x.item, distance_km: Math.round(x.km) })) };
}

module.exports = { metar, taf, nearby, normalizeMetar };
