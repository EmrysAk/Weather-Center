// Coastal — NOAA CO-OPS tide predictions and water levels (keyless).
// The station list (~3,000 stations) is cached a day; a point gets its
// nearest tide station's high/low predictions for today and tomorrow and
// the latest observed water level where the station measures one.

const { fetchJson, cached } = require('../fetch');
const geo = require('../geo');

const MIN = 60 * 1000;
const MD = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions';
const API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';

async function stations() {
  const { data } = await cached('coops:stations', 24 * 60 * MIN, async () => {
    const j = await fetchJson(MD, { source: 'coops', timeout: 40000 });
    return (j.stations || []).map(s => ({ id: s.id, name: s.name, state: s.state || null, lat: s.lat, lon: s.lng, type: s.type || null }));
  }, { staleMs: 7 * 24 * 60 * MIN });
  return data;
}

const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');

async function predictions(stationId) {
  const { data, fetched_at, stale } = await cached(`coops:pred:${stationId}`, 60 * MIN, async () => {
    const begin = ymd(new Date()), end = ymd(new Date(Date.now() + 2 * 86400 * 1000));
    const url = `${API}?product=predictions&application=weather-center&begin_date=${begin}&end_date=${end}&datum=MLLW&station=${stationId}&time_zone=lst_ldt&units=english&interval=hilo&format=json`;
    const j = await fetchJson(url, { source: 'coops' });
    return (j.predictions || []).map(p => ({ time: p.t, height_ft: parseFloat(p.v), type: p.type === 'H' ? 'high' : 'low' }));
  }, { staleMs: 24 * 60 * MIN });
  return { fetched_at, stale, tides: data };
}

async function waterLevel(stationId) {
  try {
    const { data } = await cached(`coops:wl:${stationId}`, 10 * MIN, async () => {
      const url = `${API}?product=water_level&application=weather-center&date=latest&datum=MLLW&station=${stationId}&time_zone=lst_ldt&units=english&format=json`;
      const j = await fetchJson(url, { source: 'coops' });
      const d = (j.data || [])[0];
      return d ? { time: d.t, height_ft: parseFloat(d.v) } : null;
    });
    return data;
  } catch { return null; }
}

// Nearest tide station to a point (within km), with its predictions.
async function near(lat, lon, km = 80) {
  const all = await stations();
  const [best] = geo.nearest(all, lat, lon, 1);
  if (!best || best.km > km) return { coastal: false };
  const st = best.item;
  const pred = await predictions(st.id);
  const next = pred.tides.find(t => Date.parse(t.time.replace(' ', 'T')) > Date.now()) || null;
  return { coastal: true, station: { ...st, distance_km: Math.round(best.km), url: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${st.id}` }, next, tides: pred.tides, water_level: await waterLevel(st.id), stale: pred.stale };
}

module.exports = { stations, predictions, near };
