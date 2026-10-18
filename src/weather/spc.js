// Storm Prediction Center — the severe-weather desk's primary source.
//
//   Convective outlooks (Day 1–3) as GeoJSON: categorical risk polygons
//   (TSTM · MRGL · SLGT · ENH · MDT · HIGH) plus Day 1 tornado / wind / hail
//   probabilities. Point-in-polygon answers "what is the risk HERE".
//   Today's storm reports (CSV): every tornado, hail and wind report with
//   coordinates — the ground truth the warnings were about.
//   Mesoscale discussions + watches (RSS): the forecasters' running narrative.

const { fetchJson, fetchText, cached } = require('../fetch');
const { parseFeed } = require('../rss');
const geo = require('../geo');

const MIN = 60 * 1000;
const BASE = 'https://www.spc.noaa.gov/products/outlook/';
const LAYERS = {
  1: { cat: 'day1otlk_cat.lyr.geojson', torn: 'day1otlk_torn.lyr.geojson', wind: 'day1otlk_wind.lyr.geojson', hail: 'day1otlk_hail.lyr.geojson' },
  2: { cat: 'day2otlk_cat.lyr.geojson', torn: 'day2otlk_torn.lyr.geojson', wind: 'day2otlk_wind.lyr.geojson', hail: 'day2otlk_hail.lyr.geojson' },
  3: { cat: 'day3otlk_cat.lyr.geojson', prob: 'day3otlk_prob.lyr.geojson' },
};
const CAT_RANK = { TSTM: 1, MRGL: 2, SLGT: 3, ENH: 4, MDT: 5, HIGH: 6 };
const CAT_LABEL = { TSTM: 'General thunderstorms', MRGL: 'Marginal risk (1/5)', SLGT: 'Slight risk (2/5)', ENH: 'Enhanced risk (3/5)', MDT: 'Moderate risk (4/5)', HIGH: 'High risk (5/5)' };
const CAT_COLOR = { TSTM: '#C1E9C1', MRGL: '#66A366', SLGT: '#FFE066', ENH: '#FFA366', MDT: '#E06666', HIGH: '#EE99EE' };

async function layer(day, kind) {
  const file = (LAYERS[day] || {})[kind];
  if (!file) return null;
  const { data, stale } = await cached(`spc:${day}:${kind}`, 20 * MIN, async () => {
    const j = await fetchJson(BASE + file, { source: 'spc-outlook' });
    return {
      type: 'FeatureCollection',
      features: (j.features || []).map(f => ({
        type: 'Feature', geometry: f.geometry,
        properties: { label: f.properties.LABEL, label2: f.properties.LABEL2, stroke: f.properties.stroke, fill: f.properties.fill, valid: f.properties.VALID, expire: f.properties.EXPIRE, issue: f.properties.ISSUE, rank: CAT_RANK[f.properties.LABEL] || null, color: CAT_COLOR[f.properties.LABEL] || f.properties.fill },
      })),
    };
  }, { staleMs: 6 * 60 * MIN });
  return { ...data, stale };
}

async function outlook(day = 1) {
  const kinds = Object.keys(LAYERS[day] || LAYERS[1]);
  const out = { day, layers: {} };
  await Promise.all(kinds.map(async k => { try { out.layers[k] = await layer(day, k); } catch (e) { out.layers[k] = { error: e.message }; } }));
  const cat = out.layers.cat;
  const top = cat && cat.features ? cat.features.reduce((m, f) => Math.max(m, f.properties.rank || 0), 0) : 0;
  out.max_category = Object.keys(CAT_RANK).find(k => CAT_RANK[k] === top) || null;
  out.max_label = out.max_category ? CAT_LABEL[out.max_category] : 'No thunderstorms outlooked';
  out.valid = cat && cat.features && cat.features[0] ? cat.features[0].properties.valid : null;
  out.expire = cat && cat.features && cat.features[0] ? cat.features[0].properties.expire : null;
  return out;
}

// The risk at a point for a day: highest categorical polygon containing it,
// plus the probabilistic layers (tornado/wind/hail %) on Day 1–2.
async function riskAt(lat, lon, day = 1) {
  const o = await outlook(day);
  const hit = {};
  for (const [kind, fc] of Object.entries(o.layers)) {
    if (!fc || !fc.features) continue;
    const inside = fc.features.filter(f => geo.pointInGeometry(f.geometry, lat, lon));
    if (!inside.length) continue;
    const best = inside.sort((a, b) => (b.properties.rank || 0) - (a.properties.rank || 0) || String(b.properties.label).localeCompare(String(a.properties.label)))[0];
    hit[kind] = { label: best.properties.label, label2: best.properties.label2, color: best.properties.color };
  }
  return { day, category: hit.cat ? hit.cat.label : null, category_label: hit.cat ? CAT_LABEL[hit.cat.label] : 'None', tornado: hit.torn || null, wind: hit.wind || null, hail: hit.hail || null, prob: hit.prob || null, valid: o.valid, expire: o.expire };
}

// Today's storm reports (CSV, three sections: tornado / hail / wind).
function parseReports(csv) {
  const out = [];
  let kind = null, header = null;
  for (const raw of String(csv || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Time,/.test(line)) {
      header = line.split(',').map(h => h.trim().toLowerCase());
      kind = header.includes('f_scale') ? 'tornado' : header.includes('size') ? 'hail' : header.includes('speed') ? 'wind' : kind;
      continue;
    }
    if (!header) continue;
    const cols = line.split(',');
    if (cols.length < header.length) continue;
    const r = {};
    header.forEach((h, i) => { r[h] = cols.slice(i, i === header.length - 1 ? undefined : i + 1).join(',').trim(); });
    const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      kind, time_z: r.time, lat, lon, location: r.location, county: r.county, state: r.state, comments: r.comments || '',
      magnitude: kind === 'tornado' ? (r.f_scale || null) : kind === 'hail' ? (r.size ? `${(parseInt(r.size, 10) / 100).toFixed(2)} in` : null) : (r.speed && r.speed !== 'UNK' ? `${r.speed} mph` : null),
    });
  }
  return out;
}

async function reports(which = 'today') {
  const file = which === 'yesterday' ? 'yesterday.csv' : 'today.csv';
  const { data, fetched_at, stale } = await cached(`spc:reports:${which}`, 10 * MIN, async () => parseReports(await fetchText(`https://www.spc.noaa.gov/climo/reports/${file}`, { source: 'spc-reports' })));
  const counts = { tornado: 0, hail: 0, wind: 0 };
  for (const r of data) counts[r.kind] = (counts[r.kind] || 0) + 1;
  return { which, fetched_at, stale, counts, total: data.length, reports: data };
}

async function discussions() {
  const feeds = { mesoscale: 'https://www.spc.noaa.gov/products/spcmdrss.xml', watches: 'https://www.spc.noaa.gov/products/spcwwrss.xml', outlooks: 'https://www.spc.noaa.gov/products/spcrss.xml' };
  const out = {};
  await Promise.all(Object.entries(feeds).map(async ([k, url]) => {
    try {
      const { data, stale } = await cached(`spc:rss:${k}`, 10 * MIN, async () => parseFeed(await fetchText(url, { source: 'spc-rss' })).map(i => ({ title: i.title, link: i.link, summary: i.description, published_at: i.publishedAt })));
      out[k] = { stale, items: data };
    } catch (e) { out[k] = { error: e.message, items: [] }; }
  }));
  return out;
}

module.exports = { outlook, layer, riskAt, reports, parseReports, discussions, CAT_RANK, CAT_LABEL, CAT_COLOR };
