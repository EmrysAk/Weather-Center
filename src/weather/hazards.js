// Water, fire and drought — the slower hazards.
//
//   Rivers   NWS National Water Prediction Service gauges (api.water.noaa.gov,
//            keyless): every gauge's observed stage against its flood
//            categories. "Which rivers are in flood right now" is one call.
//   Fires    InciWeb's incident feed (keyless RSS with GeoRSS points): active
//            wildfire incidents with coordinates. NASA FIRMS hotspots switch
//            on when FIRMS_MAP_KEY is set.
//   Drought  US Drought Monitor national statistics (keyless JSON): percent of
//            the country in each category, this week vs last.

const { fetchJson, fetchText, cached } = require('../fetch');
const { parseFeed } = require('../rss');
const geo = require('../geo');

const MIN = 60 * 1000;

// ─── Rivers (NWPS) ───────────────────────────────────────────────────
const FLOOD_RANK = { major: 4, moderate: 3, minor: 2, action: 1, no_flooding: 0, not_defined: -1, obs_not_current: -1, out_of_service: -1, low_threshold: 0 };
const FLOOD_COLOR = { major: '#CC33FF', moderate: '#FF0000', minor: '#FF9900', action: '#FFFF00', no_flooding: '#00AA00' };

function normalizeGauge(g) {
  const obs = (g.status && g.status.observed) || {};
  const fc = (g.status && g.status.forecast) || {};
  const cat = String(obs.floodCategory || 'not_defined').toLowerCase();
  return {
    id: g.lid, name: g.name, state: g.state && (g.state.abbreviation || g.state), county: g.county || null, wfo: g.wfo || null,
    lat: g.latitude, lon: g.longitude, river: g.reachId ? String(g.reachId) : null,
    observed: { stage: obs.primary, unit: obs.primaryUnit, flow: obs.secondary, flow_unit: obs.secondaryUnit, time: obs.validTime, category: cat, rank: FLOOD_RANK[cat] ?? -1, color: FLOOD_COLOR[cat] || '#888' },
    forecast: fc.primary != null ? { stage: fc.primary, unit: fc.primaryUnit, time: fc.validTime, category: String(fc.floodCategory || '').toLowerCase() || null } : null,
    flood_stages: g.flood && g.flood.categories ? { action: g.flood.categories.action && g.flood.categories.action.stage, minor: g.flood.categories.minor && g.flood.categories.minor.stage, moderate: g.flood.categories.moderate && g.flood.categories.moderate.stage, major: g.flood.categories.major && g.flood.categories.major.stage } : null,
    url: `https://water.noaa.gov/gauges/${g.lid}`,
  };
}

async function gauges() {
  const { data, fetched_at, stale, error } = await cached('nwps:gauges', 20 * MIN, async () => {
    const j = await fetchJson('https://api.water.noaa.gov/nwps/v1/gauges', { source: 'nwps-gauges', timeout: 90000 });
    return (j.gauges || []).map(normalizeGauge).filter(g => g.lat != null);
  }, { staleMs: 6 * 60 * MIN });
  return { fetched_at, stale, error, gauges: data };
}

// Gauges at or above a category, optionally filtered by state / near a point.
async function flooding({ min = 'action', state, lat, lon, km = 150 } = {}) {
  const { gauges: all, fetched_at, stale, error } = await gauges();
  const floor = FLOOD_RANK[min] ?? 1;
  let rows = all.filter(g => g.observed.rank >= floor);
  if (state) rows = rows.filter(g => g.state === state.toUpperCase());
  if (lat != null && lon != null) rows = geo.nearest(rows, lat, lon, 50).filter(x => x.km <= km).map(x => ({ ...x.item, distance_km: Math.round(x.km) }));
  rows.sort((a, b) => b.observed.rank - a.observed.rank || String(a.state).localeCompare(String(b.state)));
  const counts = { major: 0, moderate: 0, minor: 0, action: 0 };
  for (const g of all) if (counts[g.observed.category] != null) counts[g.observed.category]++;
  return { fetched_at, stale, error, total_gauges: all.length, counts, gauges: rows };
}

// ─── Wildfire (InciWeb + optional FIRMS) ─────────────────────────────
function parseIncidents(xml) {
  // parseFeed gives title/link/description/publishedAt; GeoRSS point is
  // pulled from the raw item so the incident lands on the map.
  const blocks = String(xml || '').match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  const items = parseFeed(xml);
  return items.map((it, i) => {
    const raw = blocks[i] || '';
    const pt = raw.match(/<georss:point>\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*<\/georss:point>/i) || raw.match(/<geo:lat>(-?\d+(?:\.\d+)?)<\/geo:lat>[\s\S]*?<geo:long>(-?\d+(?:\.\d+)?)<\/geo:long>/i);
    const acres = (it.description.match(/([\d,]+)\s*acres/i) || [])[1];
    const contained = (it.description.match(/(\d{1,3})\s*%\s*contain/i) || [])[1];
    return { title: it.title, link: it.link, summary: it.description, published_at: it.publishedAt, lat: pt ? parseFloat(pt[1]) : null, lon: pt ? parseFloat(pt[2]) : null, acres: acres ? parseInt(acres.replace(/,/g, ''), 10) : null, contained_pct: contained ? parseInt(contained, 10) : null, type: /prescribed/i.test(it.title + it.description) ? 'prescribed' : 'wildfire' };
  });
}

async function fires(env = process.env) {
  const out = {};
  try {
    const { data, fetched_at, stale } = await cached('inciweb', 15 * MIN, async () => parseIncidents(await fetchText('https://inciweb.wildfire.gov/incidents/rss.xml', { source: 'inciweb' })), { staleMs: 6 * 60 * MIN });
    out.inciweb = { fetched_at, stale, count: data.length, incidents: data };
  } catch (e) { out.inciweb = { error: e.message, incidents: [] }; }
  if (env.FIRMS_MAP_KEY) {
    try {
      const { data, stale } = await cached('firms', 30 * MIN, async () => {
        const csv = await fetchText(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${env.FIRMS_MAP_KEY}/VIIRS_SNPP_NRT/USA/1`, { source: 'nasa-firms', timeout: 40000 });
        const lines = csv.trim().split('\n'); const h = lines.shift().split(',');
        return lines.slice(0, 5000).map(l => { const c = l.split(','); const r = {}; h.forEach((k, i) => { r[k] = c[i]; }); return { lat: parseFloat(r.latitude), lon: parseFloat(r.longitude), brightness: parseFloat(r.bright_ti4), frp: parseFloat(r.frp), confidence: r.confidence, date: r.acq_date, time: r.acq_time, daynight: r.daynight }; });
      });
      out.firms = { stale, count: data.length, hotspots: data };
    } catch (e) { out.firms = { error: e.message, hotspots: [] }; }
  } else {
    out.firms = { configured: false, hotspots: [] };
  }
  return out;
}

// ─── Drought (USDM) ──────────────────────────────────────────────────
// Minimal CSV → objects (header row, no quoted commas in this feed).
function parseCsv(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(l => { const c = l.split(','); const o = {}; head.forEach((h, i) => { o[h] = (c[i] || '').trim(); }); return o; });
}

async function drought() {
  const { data, fetched_at, stale, error } = await cached('usdm:us', 6 * 60 * MIN, async () => {
    const end = new Date(); const start = new Date(end.getTime() - 21 * 86400 * 1000);
    const fmt = d => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    const url = `https://usdmdataservices.unl.edu/api/USStatistics/GetDroughtSeverityStatisticsByAreaPercent?aoi=us&startdate=${fmt(start)}&enddate=${fmt(end)}&statisticsType=1`;
    // The service answers JSON or CSV depending on its mood; take either.
    const raw = await fetchText(url, { source: 'usdm', headers: { Accept: 'application/json' } });
    let rows;
    try { rows = JSON.parse(raw); } catch { rows = parseCsv(raw); }
    const lc = w => Object.fromEntries(Object.entries(w).map(([k, v]) => [k.toLowerCase(), v]));
    const all = (Array.isArray(rows) ? rows : []).map(lc);
    // The feed can carry several areas per date (CONUS and the full US); keep one series.
    const areas = [...new Set(all.map(w => String(w.areaofinterest || '')))];
    const area = areas.find(a => /^(us|total)$/i.test(a)) || areas.find(a => /conus/i.test(a)) || areas[0];
    const weeks = all.filter(w => String(w.areaofinterest || '') === area).map(w => ({ date: w.mapdate, area, none: +w.none, d0: +w.d0, d1: +w.d1, d2: +w.d2, d3: +w.d3, d4: +w.d4 })).filter(w => w.date && Number.isFinite(w.d1)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return { latest: weeks[0] || null, previous: weeks[1] || null, weeks };
  }, { staleMs: 7 * 24 * 60 * MIN });
  return { fetched_at, stale, error, ...data, categories: { D0: 'Abnormally dry', D1: 'Moderate drought', D2: 'Severe drought', D3: 'Extreme drought', D4: 'Exceptional drought' } };
}

module.exports = { gauges, flooding, fires, parseIncidents, drought, parseCsv, normalizeGauge, FLOOD_RANK, FLOOD_COLOR };
