// Weather Center — the newsroom's weather desk as a live operations console.
//
// It does not collect weather NEWS itself: the Newsroom Search Engine (:3003)
// polls the feeds, dedups, scores credibility and detects trends; this
// service pulls that desk through the newsroom's cursor API into a local
// mirror. What it adds is the weather itself, straight from the primary
// sources — NWS alerts and forecasts, SPC outlooks and storm reports, NHC
// tropical systems, USGS earthquakes, NWPS river gauges, InciWeb fires, the
// Drought Monitor, aviation METARs, CO-OPS tides, SWPC space weather,
// RainViewer radar/satellite — and the briefing the Newsroom Reporters read.
//
// Entry point only: configuration → services → routes → schedules.
// Everything except /health and the page itself requires a bearer token
// (src/auth.js; mint with scripts/make-token.js).

const loadedEnv = require('./src/env').loadEnv();

const http = require('http');
const path = require('path');

const { authenticate, loadHashes } = require('./src/auth');
const { DATA_DIR } = require('./src/paths');
const { json, text, serveStatic, makeCors, readJsonBody, intParam, floatParam, strParam } = require('./src/http');
const { sourceStats, cacheStats } = require('./src/fetch');
const { JsonFile, Mirror } = require('./src/store');
const { Newsroom } = require('./src/newsroom');
const geocode = require('./src/weather/geocode');
const alerts = require('./src/weather/alerts');
const forecast = require('./src/weather/forecast');
const tropical = require('./src/weather/tropical');
const spc = require('./src/weather/spc');
const quakes = require('./src/weather/quakes');
const radar = require('./src/weather/radar');
const hazards = require('./src/weather/hazards');
const aviation = require('./src/weather/aviation');
const space = require('./src/weather/space');
const tides = require('./src/weather/tides');
const briefing = require('./src/weather/briefing');

// ─── Configuration ───────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3006', 10);
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const POLL_DISABLED = process.env.POLL_DISABLED === '1';
const NEWSROOM_POLL_MS = parseInt(process.env.NEWSROOM_POLL_MS || String(2 * 60 * 1000), 10);
const MIRROR_MAX_ROWS = parseInt(process.env.MIRROR_MAX_ROWS || '20000', 10);
const DESK = 'weather';

// ─── Services ────────────────────────────────────────────────────────
if (loadedEnv.length) console.log(`env: loaded ${loadedEnv.join(', ')} from .env`);
const tokenCount = loadHashes();
console.log(tokenCount > 0 ? `auth: ${tokenCount} token hash(es) loaded` : 'auth: NO TOKENS CONFIGURED — the API will refuse until scripts/make-token.js is run');

const mirror = new Mirror(path.join(DATA_DIR, 'mirror'), DESK, { maxRows: MIRROR_MAX_ROWS });
const newsroom = new Newsroom({ url: process.env.NEWSROOM_URL, token: process.env.NEWSROOM_TOKEN, desk: DESK, mirror });
console.log(newsroom.enabled ? `newsroom: ${newsroom.url} (desk ${DESK}) — mirror holds ${mirror.size} rows` : 'newsroom: not configured (set NEWSROOM_URL + NEWSROOM_TOKEN) — news panels will be empty');

// Watched locations: the NOW board. Ships with a few metros so the board is
// never blank; operators add and remove their own.
const DEFAULT_WATCH = [
  { id: 'nyc', label: 'New York, NY', lat: 40.7128, lon: -74.006 }, { id: 'chi', label: 'Chicago, IL', lat: 41.8781, lon: -87.6298 },
  { id: 'hou', label: 'Houston, TX', lat: 29.7604, lon: -95.3698 }, { id: 'mia', label: 'Miami, FL', lat: 25.7617, lon: -80.1918 },
  { id: 'lax', label: 'Los Angeles, CA', lat: 34.0522, lon: -118.2437 }, { id: 'den', label: 'Denver, CO', lat: 39.7392, lon: -104.9903 },
  { id: 'sea', label: 'Seattle, WA', lat: 47.6062, lon: -122.3321 }, { id: 'atl', label: 'Atlanta, GA', lat: 33.749, lon: -84.388 },
  { id: 'okc', label: 'Oklahoma City, OK', lat: 35.4676, lon: -97.5164 }, { id: 'msy', label: 'New Orleans, LA', lat: 29.9511, lon: -90.0715 },
];
const watch = new JsonFile(path.join(DATA_DIR, 'watch.json'), () => ({ locations: DEFAULT_WATCH }));

// ─── Helpers ─────────────────────────────────────────────────────────
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const bad = (msg, extra) => new HttpError(400, msg, extra);

// A location from ?q= (place name or "lat,lon") or ?lat=&lon=.
async function locate(url) {
  const lat = floatParam(url, 'lat'), lon = floatParam(url, 'lon');
  if (lat != null && lon != null) {
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw bad('lat/lon out of range');
    return { lat, lon, label: strParam(url, 'label') || `${lat.toFixed(3)}, ${lon.toFixed(3)}` };
  }
  const q = strParam(url, 'q');
  if (!q) throw bad('q (place or "lat,lon") or lat & lon required');
  const hit = await geocode.resolve(q);
  if (!hit) throw new HttpError(404, `no place found for "${q}"`);
  return { lat: hit.lat, lon: hit.lon, label: hit.label, place: hit };
}

// ─── Routes ──────────────────────────────────────────────────────────
// [method, path, async (url, req) => body]. Bodies are sent as 200 JSON.
const routes = [
  ['GET', '/api/status', async () => ({
    ok: true, service: 'weather-center', desk: DESK, port: PORT, polling: !POLL_DISABLED, tokens: tokenCount,
    newsroom: { ...newsroom.status(), health: await newsroom.health() },
    watch: watch.value.locations.length, sources: sourceStats(), cache: cacheStats(),
    uptime_s: Math.round(process.uptime()), rss_mb: Math.round(process.memoryUsage().rss / 1048576),
  })],

  // Alerts
  ['GET', '/api/alerts', async url => {
    const lat = floatParam(url, 'lat'), lon = floatParam(url, 'lon');
    return alerts.list({ state: strParam(url, 'state', 2), event: strParam(url, 'event'), severity: strParam(url, 'severity'), urgency: strParam(url, 'urgency'), q: strParam(url, 'q'), limit: intParam(url, 'limit', 500, 1, 2000), point: lat != null && lon != null ? { lat, lon } : null });
  }],
  ['GET', '/api/alerts/summary', () => alerts.summary()],
  ['GET', '/api/alerts/geojson', url => alerts.geojson({ state: strParam(url, 'state', 2), event: strParam(url, 'event') })],
  ['GET', '/api/alerts/one', async url => { const a = await alerts.byId(strParam(url, 'id', 300)); if (!a) throw new HttpError(404, 'no such alert (it may have expired)'); return a; }],
  ['GET', '/api/point-alerts', async url => {
    const loc = await locate(url);
    let zoneIds = [];
    try { const p = await forecast.nwsPoint(loc.lat, loc.lon); zoneIds = [p.zone && `https://api.weather.gov/zones/forecast/${p.zone}`, p.county && `https://api.weather.gov/zones/county/${p.county}`, p.fire_zone && `https://api.weather.gov/zones/fire/${p.fire_zone}`].filter(Boolean); } catch { /* outside NWS */ }
    return { location: loc, ...(await alerts.atPoint(loc.lat, loc.lon, { zoneIds })) };
  }],

  // Places + conditions
  ['GET', '/api/geocode', async url => { const q = strParam(url, 'q'); if (!q) throw bad('q required'); return { q, results: await geocode.geocode(q, intParam(url, 'count', 6, 1, 10)) }; }],
  ['GET', '/api/conditions', async url => { const loc = await locate(url); return { location: loc, ...(await forecast.conditions(loc.lat, loc.lon, { hours: intParam(url, 'hours', 48, 6, 168), days: intParam(url, 'days', 7, 1, 16) })) }; }],
  ['GET', '/api/airquality', async url => { const loc = await locate(url); return { location: loc, ...(await forecast.airQuality(loc.lat, loc.lon)) }; }],

  // Tropical
  ['GET', '/api/tropical', () => tropical.storms()],
  ['GET', '/api/tropical/outlook', () => tropical.outlook()],

  // Severe (SPC)
  ['GET', '/api/spc/outlook', url => spc.outlook(intParam(url, 'day', 1, 1, 3))],
  ['GET', '/api/spc/risk', async url => { const loc = await locate(url); return { location: loc, ...(await spc.riskAt(loc.lat, loc.lon, intParam(url, 'day', 1, 1, 3))) }; }],
  ['GET', '/api/spc/reports', url => spc.reports(strParam(url, 'which') === 'yesterday' ? 'yesterday' : 'today')],
  ['GET', '/api/spc/discussions', () => spc.discussions()],

  // Earthquakes
  ['GET', '/api/quakes', url => quakes.list({ feed: strParam(url, 'feed', 30) || '2.5_day', minMag: floatParam(url, 'min') || 0, limit: intParam(url, 'limit', 500, 1, 5000) })],
  ['GET', '/api/quakes/near', async url => { const loc = await locate(url); return { location: loc, quakes: await quakes.near(loc.lat, loc.lon, { km: intParam(url, 'km', 500, 10, 5000), feed: strParam(url, 'feed', 30) || '2.5_week' }) }; }],

  // Imagery
  ['GET', '/api/radar', () => radar.frames()],

  // Water · fire · drought
  ['GET', '/api/rivers', url => { const lat = floatParam(url, 'lat'), lon = floatParam(url, 'lon'); return hazards.flooding({ min: strParam(url, 'min', 12) || 'action', state: strParam(url, 'state', 2), lat, lon, km: intParam(url, 'km', 150, 10, 2000) }); }],
  ['GET', '/api/fires', () => hazards.fires(process.env)],
  ['GET', '/api/drought', () => hazards.drought()],

  // Aviation
  ['GET', '/api/metar', url => aviation.metar(strParam(url, 'ids', 200))],
  ['GET', '/api/taf', url => aviation.taf(strParam(url, 'ids', 100))],
  ['GET', '/api/metar/near', async url => { const loc = await locate(url); return { location: loc, ...(await aviation.nearby(loc.lat, loc.lon)) }; }],

  // Space weather · tides
  ['GET', '/api/space', () => space.summary()],
  ['GET', '/api/tides', async url => { const loc = await locate(url); return { location: loc, ...(await tides.near(loc.lat, loc.lon, intParam(url, 'km', 80, 5, 500))) }; }],

  // The newsroom's weather desk (mirrored) + its trend events
  ['GET', '/api/news', url => ({
    configured: newsroom.enabled, mirror: mirror.stats(),
    rows: mirror.query({ q: strParam(url, 'q'), cls: strParam(url, 'class', 40), since: strParam(url, 'since', 40), limit: intParam(url, 'limit', 50, 1, 500), order: strParam(url, 'order') === 'asc' ? 'asc' : 'desc' }),
  })],
  ['GET', '/api/events', async url => ({ configured: newsroom.enabled, events: newsroom.enabled ? await newsroom.events(intParam(url, 'limit', 40, 1, 100)) : [] })],
  ['POST', '/api/newsroom/poll', async () => ({ ok: true, added: await newsroom.poll(), mirror: mirror.stats() })],

  // The briefing
  ['GET', '/api/briefing', async url => {
    const loc = await locate(url);
    let events = [];
    if (newsroom.enabled) { try { events = await newsroom.events(10); } catch { /* briefing still useful */ } }
    return briefing.build({ lat: loc.lat, lon: loc.lon, label: loc.label, newsroomMirror: mirror, newsroomEvents: events });
  }],

  // Watched locations (the NOW board)
  ['GET', '/api/watch', () => watch.value],
  ['POST', '/api/watch', async (url, req) => {
    const body = await readJsonBody(req);
    const q = String((body && body.q) || '').trim();
    if (!q || q.length > 120) throw bad('q (place name or "lat,lon") required');
    const hit = await geocode.resolve(q);
    if (!hit) throw new HttpError(404, `no place found for "${q}"`);
    const id = `${hit.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Math.round(hit.lat * 10)}${Math.round(hit.lon * 10)}`.replace('--', '-');
    const list = watch.value.locations.filter(l => l.id !== id);
    if (list.length >= 40) throw bad('watch list is full (40)');
    list.push({ id, label: hit.label, lat: hit.lat, lon: hit.lon, admin1: hit.admin1, country_code: hit.country_code });
    watch.save({ locations: list });
    return { ok: true, added: list[list.length - 1], locations: list };
  }],
  ['DELETE', '/api/watch', url => {
    const id = strParam(url, 'id', 120);
    const list = watch.value.locations.filter(l => l.id !== id);
    if (list.length === watch.value.locations.length) throw new HttpError(404, 'not watched');
    watch.save({ locations: list });
    return { ok: true, locations: list };
  }],
  // One row per watched location: current conditions + alerts in effect.
  ['GET', '/api/watch/board', async () => {
    const rows = await Promise.all(watch.value.locations.map(async l => {
      try {
        const [om, al] = await Promise.all([forecast.openMeteo(l.lat, l.lon, { days: 2 }), alerts.list({ point: { lat: l.lat, lon: l.lon }, limit: 10 })]);
        const today = om.daily[0] || {};
        return { ...l, ok: true, temp_f: om.current.temp_f, feels_f: om.current.feels_f, text: om.current.weather.text, glyph: om.current.weather.glyph, is_day: om.current.is_day, wind_mph: om.current.wind_mph, gust_mph: om.current.gust_mph, wind_compass: om.current.wind_compass, humidity: om.current.humidity, high_f: today.high_f, low_f: today.low_f, precip_chance: today.precip_chance, alerts: al.alerts.map(a => ({ id: a.id, event: a.event, color: a.color, expires: a.expires, severity: a.severity })), stale: om.stale };
      } catch (e) { return { ...l, ok: false, error: e.message }; }
    }));
    return { generated_at: new Date().toISOString(), locations: rows };
  }],
];

const PUBLIC = new Set(['/', '/health', '/index.html', '/app.js', '/style.css', '/favicon.svg']);

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return json(res, 400, { error: 'bad request' }); }
  const cors = corsFor(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  if (url.pathname === '/health') return json(res, 200, { ok: true, service: 'weather-center' }, cors);
  if (req.method === 'GET' && PUBLIC.has(url.pathname) && serveStatic(res, url.pathname)) return undefined;

  // Everything else is private.
  const auth = authenticate(req);
  if (!auth.ok) return json(res, auth.status, { error: auth.error }, cors);

  if (url.pathname === '/briefing.txt') {
    try {
      const loc = await locate(url);
      const b = await briefing.build({ lat: loc.lat, lon: loc.lon, label: loc.label, newsroomMirror: mirror, newsroomEvents: newsroom.enabled ? await newsroom.events(10).catch(() => []) : [] });
      return text(res, 200, b.text, cors);
    } catch (e) { return json(res, e.status || 502, { error: e.message }, cors); }
  }

  const matches = routes.filter(r => r[1] === url.pathname);
  if (!matches.length) return json(res, 404, { error: 'not found' }, cors);
  const route = matches.find(r => r[0] === req.method);
  if (!route) return json(res, 405, { error: 'method not allowed', allow: matches.map(r => r[0]) }, cors);
  try {
    const body = await route[2](url, req, res);
    return json(res, 200, body, cors);
  } catch (e) {
    const status = e.status || (/^HTTP \d{3}|fetch failed|timeout|aborted|ENOTFOUND|ECONN|not JSON/i.test(e.message) ? 502 : 500);
    if (status >= 500) console.warn(`${req.method} ${url.pathname} → ${status}: ${e.message}`);
    return json(res, status, { error: e.message, ...(e.extra || {}) }, cors);
  }
}

const corsFor = makeCors(CORS_ORIGINS);
const server = http.createServer((req, res) => {
  Promise.resolve().then(() => handle(req, res)).catch(err => {
    console.error('handler error:', err && err.message);
    if (!res.headersSent) { try { json(res, 500, { error: 'internal error' }); } catch { /* gone */ } }
    res.end();
  });
});
server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
process.on('unhandledRejection', err => console.error('unhandledRejection:', err && err.message));
process.on('uncaughtException', err => console.error('uncaughtException:', err && err.message));

// ─── Schedules ───────────────────────────────────────────────────────
if (!POLL_DISABLED) {
  newsroom.start(NEWSROOM_POLL_MS);
  // Keep the national picture warm so the first page load is instant.
  // The NWPS gauge list and CO-OPS station list are the two big downloads;
  // fetching them at boot means the first WATER view and coastal forecast
  // don't wait on them.
  const warm = () => { alerts.load().catch(() => {}); tropical.storms().catch(() => {}); spc.outlook(1).catch(() => {}); hazards.gauges().catch(() => {}); radar.frames().catch(() => {}); };
  setTimeout(() => tides.stations().catch(() => {}), 5000).unref();
  setTimeout(warm, 500).unref();
  setInterval(warm, 2 * 60 * 1000).unref();
}

// ─── Listen ──────────────────────────────────────────────────────────
server.requestTimeout = 60000;
server.headersTimeout = 15000;
server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') console.error(`FATAL: port ${PORT} is already in use (service table: 3001 Brief SE · 3002 Sports · 3003 Newsroom · 3004 Prediction Lab · 3005 Military · 3006 Weather). Set PORT in .env.`);
  else console.error(`FATAL: cannot listen on :${PORT} — ${err && err.message}`);
  process.exit(1);
});
server.listen(PORT, () => console.log(`weather-center listening on :${PORT} — ${routes.length} API routes, ${watch.value.locations.length} watched locations`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
}
