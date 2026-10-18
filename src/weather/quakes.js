// Earthquakes — USGS GeoJSON summary feeds (keyless, updated every minute).

const { fetchJson, cached } = require('../fetch');
const geo = require('../geo');

const MIN = 60 * 1000;
const FEEDS = {
  'all_hour': 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
  'all_day': 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
  '2.5_day': 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
  '2.5_week': 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson',
  '4.5_day': 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson',
  '4.5_week': 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson',
  'significant_month': 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson',
};

function normalize(f) {
  const p = f.properties || {};
  const [lon, lat, depth] = (f.geometry && f.geometry.coordinates) || [null, null, null];
  return {
    id: f.id, mag: p.mag, place: p.place, time: p.time ? new Date(p.time).toISOString() : null, updated: p.updated ? new Date(p.updated).toISOString() : null,
    lat, lon, depth_km: depth, url: p.url, felt: p.felt, cdi: p.cdi, mmi: p.mmi, alert: p.alert || null, tsunami: p.tsunami === 1, sig: p.sig,
    type: p.type, status: p.status, net: p.net, mag_type: p.magType,
    color: p.mag >= 7 ? '#8B0000' : p.mag >= 6 ? '#FF0000' : p.mag >= 5 ? '#FF8C00' : p.mag >= 4 ? '#FFD700' : p.mag >= 2.5 ? '#9ACD32' : '#87CEEB',
  };
}

async function feed(name = '2.5_day') {
  const url = FEEDS[name] || FEEDS['2.5_day'];
  const { data, fetched_at, stale, error } = await cached(`usgs:${name}`, 2 * MIN, async () => {
    const j = await fetchJson(url, { source: 'usgs-quakes' });
    return { generated: j.metadata && j.metadata.generated ? new Date(j.metadata.generated).toISOString() : null, title: j.metadata && j.metadata.title, quakes: (j.features || []).map(normalize) };
  }, { staleMs: 30 * MIN });
  return { feed: name, fetched_at, stale, error, ...data, count: data.quakes.length };
}

async function list({ feed: name = '2.5_day', minMag = 0, limit = 500 } = {}) {
  const f = await feed(name);
  const quakes = f.quakes.filter(q => (q.mag || 0) >= minMag).slice(0, limit);
  return { ...f, quakes, count: quakes.length, largest: quakes.slice().sort((a, b) => (b.mag || 0) - (a.mag || 0))[0] || null };
}

async function near(lat, lon, { km = 500, feed: name = '2.5_week' } = {}) {
  const f = await feed(name);
  return geo.nearest(f.quakes, lat, lon, 25).filter(x => x.km <= km).map(x => ({ ...x.item, distance_km: Math.round(x.km), distance_mi: geo.kmToMi(x.km) }));
}

module.exports = { feed, list, near, normalize, FEEDS };
