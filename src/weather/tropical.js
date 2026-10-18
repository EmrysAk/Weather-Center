// Tropical cyclones — the National Hurricane Center.
//
//   CurrentStorms.json   every active system in the Atlantic / East Pacific /
//                        Central Pacific with position, intensity, movement,
//                        pressure and links to the advisory products.
//   index-at.xml etc.    the basin RSS: the Tropical Weather Outlook text and
//                        advisory headlines (for the narrative).

const { fetchJson, fetchText, cached } = require('../fetch');
const { parseFeed } = require('../rss');
const geo = require('../geo');

const MIN = 60 * 1000;
const STORMS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const BASIN_FEEDS = { atlantic: 'https://www.nhc.noaa.gov/index-at.xml', eastern_pacific: 'https://www.nhc.noaa.gov/index-ep.xml', central_pacific: 'https://www.nhc.noaa.gov/index-cp.xml' };

// Saffir-Simpson from sustained wind (mph).
function category(windMph) {
  if (windMph == null) return null;
  if (windMph >= 157) return { n: 5, label: 'Category 5', color: '#8B0000' };
  if (windMph >= 130) return { n: 4, label: 'Category 4', color: '#FF0000' };
  if (windMph >= 111) return { n: 3, label: 'Category 3', color: '#FF6600' };
  if (windMph >= 96) return { n: 2, label: 'Category 2', color: '#FFA500' };
  if (windMph >= 74) return { n: 1, label: 'Category 1', color: '#FFD700' };
  if (windMph >= 39) return { n: 0, label: 'Tropical Storm', color: '#00BFFF' };
  return { n: -1, label: 'Tropical Depression', color: '#5F9EA0' };
}

const parseLat = s => { const m = String(s || '').match(/^(-?\d+(?:\.\d+)?)\s*([NS])?/i); return m ? parseFloat(m[1]) * (/S/i.test(m[2] || '') ? -1 : 1) : null; };
const parseLon = s => { const m = String(s || '').match(/^(-?\d+(?:\.\d+)?)\s*([EW])?/i); return m ? parseFloat(m[1]) * (/W/i.test(m[2] || '') ? -1 : 1) : null; };

function normalizeStorm(s) {
  const windMph = s.intensity != null ? Math.round(Number(s.intensity) * 1.15078) : null;   // NHC reports knots
  return {
    id: s.id, binNumber: s.binNumber || null, name: s.name, classification: s.classification || null,
    basin: /^al/i.test(s.id) ? 'atlantic' : /^ep/i.test(s.id) ? 'eastern_pacific' : /^cp/i.test(s.id) ? 'central_pacific' : 'other',
    lat: typeof s.latitudeNumeric === 'number' ? s.latitudeNumeric : parseLat(s.latitude),
    lon: typeof s.longitudeNumeric === 'number' ? s.longitudeNumeric : parseLon(s.longitude),
    wind_kt: s.intensity != null ? Number(s.intensity) : null, wind_mph: windMph, category: category(windMph),
    pressure_mb: s.pressure != null ? Number(s.pressure) : null,
    movement: { dir: s.movementDir != null ? Number(s.movementDir) : null, compass: geo.compass(s.movementDir != null ? Number(s.movementDir) : null), speed_kt: s.movementSpeed != null ? Number(s.movementSpeed) : null, speed_mph: s.movementSpeed != null ? Math.round(Number(s.movementSpeed) * 1.15078) : null },
    last_update: s.lastUpdate || null,
    products: {
      advisory: s.publicAdvisory && s.publicAdvisory.url, forecast: s.forecastAdvisory && s.forecastAdvisory.url,
      discussion: s.forecastDiscussion && s.forecastDiscussion.url, graphics: s.forecastGraphics && s.forecastGraphics.url,
      cone: s.trackCone && s.trackCone.kmzFile, wind_probs: s.windSpeedProbabilities && s.windSpeedProbabilities.url,
    },
  };
}

async function storms() {
  const { data, fetched_at, stale, error } = await cached('nhc:storms', 10 * MIN, async () => {
    const j = await fetchJson(STORMS_URL, { source: 'nhc-storms' });
    return (j.activeStorms || []).map(normalizeStorm);
  }, { staleMs: 3 * 60 * MIN });
  return { fetched_at, stale, error, count: data.length, storms: data };
}

// Tropical Weather Outlook + advisory headlines per basin (text products).
async function outlook() {
  const out = {};
  await Promise.all(Object.entries(BASIN_FEEDS).map(async ([basin, url]) => {
    try {
      const { data, stale } = await cached(`nhc:feed:${basin}`, 15 * MIN, async () => {
        const xml = await fetchText(url, { source: 'nhc-rss' });
        return parseFeed(xml).map(i => ({ title: i.title, link: i.link, summary: i.description, published_at: i.publishedAt, kind: /outlook/i.test(i.title) ? 'outlook' : /advisory/i.test(i.title) ? 'advisory' : /discussion/i.test(i.title) ? 'discussion' : 'other' }));
      }, { staleMs: 3 * 60 * MIN });
      out[basin] = { stale, items: data };
    } catch (e) {
      out[basin] = { error: e.message, items: [] };
    }
  }));
  return out;
}

// Storms within `km` of a point, nearest first — the "is anything headed
// this way" question a briefing asks.
async function near(lat, lon, km = 1200) {
  const { storms: list } = await storms();
  return geo.nearest(list, lat, lon, 10).filter(x => x.km <= km).map(x => ({ ...x.item, distance_km: Math.round(x.km), distance_mi: geo.kmToMi(x.km) }));
}

module.exports = { storms, outlook, near, category, normalizeStorm };
