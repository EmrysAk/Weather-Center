const path = require('path');

module.exports = async ({ assert, TMP }) => {
  // ─── geo ───────────────────────────────────────────────────────────
  const geo = require('../src/geo');
  assert(Math.round(geo.haversineKm(40.7128, -74.006, 34.0522, -118.2437)) === 3936, 'haversine NYC→LA ≈ 3,936 km');
  const square = { type: 'Polygon', coordinates: [[[-100, 30], [-90, 30], [-90, 40], [-100, 40], [-100, 30]]] };
  assert(geo.pointInGeometry(square, 35, -95) === true && geo.pointInGeometry(square, 45, -95) === false, 'point-in-polygon inside / outside');
  const holed = { type: 'Polygon', coordinates: [square.coordinates[0], [[-96, 34], [-94, 34], [-94, 36], [-96, 36], [-96, 34]]] };
  assert(geo.pointInGeometry(holed, 35, -95) === false, 'point inside a hole is outside');
  const multi = { type: 'MultiPolygon', coordinates: [square.coordinates, [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]] };
  assert(geo.pointInGeometry(multi, 0.5, 0.5) === true, 'MultiPolygon tests every part');
  assert(JSON.stringify(geo.bboxOf(square)) === '[-100,30,-90,40]', 'bbox of a polygon');
  assert(geo.parseLatLon(' 35.2, -97.4 ').lat === 35.2 && geo.parseLatLon('91,0') === null && geo.parseLatLon('Tulsa') === null, 'parseLatLon accepts coordinates only, in range');
  assert(geo.compass(0) === 'N' && geo.compass(225) === 'SW' && geo.compass(359) === 'N' && geo.compass(null) === null, 'compass points');
  assert(geo.cToF(100) === 212 && geo.kmhToMph(100) === 62.1 && geo.paToInHg(101325) === 29.92, 'unit conversions');
  const near = geo.nearest([{ lat: 0, lon: 0, n: 'a' }, { lat: 1, lon: 1, n: 'b' }, { lat: null, lon: null, n: 'c' }], 0.9, 0.9, 5);
  assert(near.length === 2 && near[0].item.n === 'b', 'nearest sorts by distance and drops items without coordinates');

  // ─── store ─────────────────────────────────────────────────────────
  const { JsonFile, Mirror } = require('../src/store');
  const jf = new JsonFile(path.join(TMP, 'w.json'), () => ({ locations: [1] }));
  assert(jf.value.locations[0] === 1, 'JsonFile falls back when missing');
  jf.save({ locations: [1, 2] });
  assert(new JsonFile(path.join(TMP, 'w.json'), {}).value.locations.length === 2, 'JsonFile persists atomically');
  const m = new Mirror(path.join(TMP, 'mirror'), 'weather', { maxRows: 5 });
  const row = (i, h = `Storm ${i}`) => ({ id: `r${i}`, headline: h, snippet: '', source: 's', classes: i % 2 ? ['severe'] : [], ingested_at: new Date(1700000000000 + i * 1000).toISOString() });
  assert(m.upsert([row(1), row(2), row(2)]) === 2, 'mirror upserts new ids only');
  assert(m.meta.cursor === row(2).ingested_at, 'cursor advances to the newest ingested_at');
  m.upsert([row(3), row(4), row(5), row(6), row(7)]);
  assert(m.size === 5 && !m.byId.has('r1') && m.byId.has('r7'), 'mirror is bounded, oldest dropped');
  assert(m.query({ limit: 2 })[0].id === 'r7' && m.query({ limit: 2, order: 'asc' })[0].id === 'r3', 'query newest-first by default, asc on request');
  assert(m.query({ cls: 'severe' }).every(r => r.classes.includes('severe')) && m.query({ q: 'storm 6' }).length === 1, 'query filters by class and text');
  m.saveMeta({ last_error: 'x' });
  const m2 = new Mirror(path.join(TMP, 'mirror'), 'weather', { maxRows: 5 });
  assert(m2.size === 5 && m2.meta.cursor === m.meta.cursor && m2.meta.last_error === 'x', 'mirror reloads rows and meta from disk');

  // ─── alerts (fixture) ──────────────────────────────────────────────
  const { setFetch, clearCache } = require('../src/fetch');
  const alerts = require('../src/weather/alerts');
  const feature = (id, event, extra = {}) => ({
    id, type: 'Feature', geometry: extra.geometry === undefined ? square : extra.geometry,
    properties: { id, event, severity: extra.severity || 'Severe', urgency: 'Immediate', certainty: 'Observed', headline: `${event} issued`, areaDesc: extra.area || 'Oklahoma County, OK', sent: '2026-10-18T12:00:00Z', expires: '2026-10-18T13:00:00Z',
      description: extra.description || 'desc', instruction: 'take cover', senderName: 'NWS Norman OK', geocode: { UGC: extra.ugc || ['OKC109'] }, affectedZones: extra.zones || ['https://api.weather.gov/zones/county/OKC109'],
      parameters: { NWSheadline: ['HEADLINE'], VTEC: ['/O.NEW.KOUN.TO.W.0001.000000T0000Z-000000T0000Z/'], tornadoDetection: extra.radar ? ['RADAR INDICATED'] : undefined, maxHailSize: ['1.75'] } },
  });
  const fixture = { updated: '2026-10-18T12:05:00Z', features: [
    feature('a1', 'Severe Thunderstorm Warning'), feature('a2', 'Tornado Warning', { radar: true }),
    feature('a3', 'Flash Flood Warning', { description: 'This is a FLASH FLOOD EMERGENCY for Tulsa', ugc: ['OKC143'] }),
    feature('a4', 'Winter Storm Watch', { geometry: null, ugc: ['COZ040'], zones: ['https://api.weather.gov/zones/forecast/COZ040'], area: 'Denver, CO', severity: 'Moderate' }),
  ] };
  setFetch(async url => ({ ok: true, status: 200, text: async () => JSON.stringify(fixture) }));
  clearCache();
  const sum = await alerts.summary();
  assert(sum.total === 4 && sum.tornado_warnings === 1 && sum.flash_flood_emergencies === 1 && sum.warnings === 3 && sum.watches === 1, 'alert summary counts totals, tornado warnings, emergencies, warnings/watches');
  assert(sum.by_event[0].event === 'Tornado Warning' && sum.by_state[0].state === 'OK' && sum.by_state[0].count === 3, 'summary ranks life-threatening events first and counts by state from UGC');
  const l = await alerts.list({ state: 'ok' });
  assert(l.total === 3 && l.alerts[0].event === 'Tornado Warning' && l.alerts[0].tornado_detection === 'RADAR INDICATED' && l.alerts[0].max_hail_size === '1.75' && !('geometry' in l.alerts[0]), 'list filters by state, sorts by priority, carries parameters, strips polygons');
  assert((await alerts.list({ point: { lat: 35, lon: -95 } })).total === 3 && (await alerts.list({ point: { lat: 45, lon: -95 } })).total === 0, 'point filter uses the polygon');
  const at = await alerts.atPoint(45, -105, { zoneIds: ['https://api.weather.gov/zones/forecast/COZ040'] });
  assert(at.alerts.length === 1 && at.alerts[0].event === 'Winter Storm Watch', 'zone-based alerts (no polygon) resolve by zone id');
  const gj = await alerts.geojson({ event: 'tornado' });
  assert(gj.features.length === 1 && gj.features[0].properties.color === '#FF0000', 'alert GeoJSON carries the NWS color');
  assert((await alerts.byId('a3')).event_key === 'Flash Flood Warning (Emergency)', 'a Flash Flood Emergency is flagged from the text');

  // stale-on-error: the source goes down, the last good answer still serves
  setFetch(async () => { throw new Error('ECONNRESET'); });
  const { cached } = require('../src/fetch');
  await cached('t:x', 1, async () => 'first');
  await new Promise(r => setTimeout(r, 5));
  const stale = await cached('t:x', 1, async () => { throw new Error('down'); }, { staleMs: 60000 });
  assert(stale.data === 'first' && stale.stale === true && stale.error === 'down', 'cache serves stale data with the error when a refresh fails');

  // ─── SPC reports CSV · InciWeb RSS · tropical · forecast codes ─────
  const spc = require('../src/weather/spc');
  const csv = 'Time,F_Scale,Location,County,State,Lat,Lon,Comments\n1830,UNK,3 N Moore,Cleveland,OK,35.38,-97.49,Tornado on the ground (OUN)\nTime,Size,Location,County,State,Lat,Lon,Comments\n1900,175,Norman,Cleveland,OK,35.22,-97.44,Golf ball hail (OUN)\nTime,Speed,Location,County,State,Lat,Lon,Comments\n1915,UNK,Edmond,Oklahoma,OK,35.65,-97.48,Trees down, roof damage (OUN)\n';
  const reps = spc.parseReports(csv);
  assert(reps.length === 3 && reps[0].kind === 'tornado' && reps[1].kind === 'hail' && reps[1].magnitude === '1.75 in' && reps[2].kind === 'wind' && /roof damage/.test(reps[2].comments), 'SPC storm reports parse all three sections incl. commas in comments');
  const hazards = require('../src/weather/hazards');
  const rss = '<rss><channel><item><title>Big Fire (Wildfire)</title><link>https://inciweb.wildfire.gov/i/1</link><description>12,345 acres, 40% contained</description><pubDate>Sat, 18 Oct 2026 10:00:00 GMT</pubDate><georss:point>44.1 -115.2</georss:point></item></channel></rss>';
  const inc = hazards.parseIncidents(rss);
  assert(inc.length === 1 && inc[0].lat === 44.1 && inc[0].lon === -115.2 && inc[0].acres === 12345 && inc[0].contained_pct === 40, 'InciWeb incidents carry coordinates, acreage and containment');
  const g = hazards.normalizeGauge({ lid: 'TULO2', name: 'Arkansas River at Tulsa', state: { abbreviation: 'OK' }, latitude: 36.1, longitude: -96, status: { observed: { primary: 19.2, primaryUnit: 'ft', floodCategory: 'moderate', validTime: '2026-10-18T12:00:00Z' }, forecast: { primary: 21, floodCategory: 'major' } }, flood: { categories: { action: { stage: 15 }, minor: { stage: 18 }, moderate: { stage: 19 }, major: { stage: 21 } } } });
  assert(g.observed.rank === 3 && g.forecast.category === 'major' && g.flood_stages.major === 21, 'NWPS gauge normalizes flood category, forecast and stages');
  const tropical = require('../src/weather/tropical');
  const st = tropical.normalizeStorm({ id: 'al092026', name: 'Melissa', classification: 'HU', latitude: '17.5N', longitude: '77.2W', intensity: '140', pressure: '920', movementDir: 20, movementSpeed: 7, lastUpdate: '2026-10-18T09:00:00Z' });
  assert(st.basin === 'atlantic' && st.lat === 17.5 && st.lon === -77.2 && st.wind_mph === 161 && st.category.n === 5 && st.movement.compass === 'NNE', 'NHC storm normalizes position, knots→mph, Saffir-Simpson, movement');
  assert(tropical.category(60).label === 'Tropical Storm' && tropical.category(30).n === -1, 'category thresholds');
  const forecast = require('../src/weather/forecast');
  assert(forecast.wmo(95).text === 'Thunderstorm' && forecast.wmo(999).text === 'Unknown' && forecast.aqiBand(42).label === 'Good' && forecast.aqiBand(180).label === 'Unhealthy', 'WMO codes and AQI bands');

  // ─── briefing text ─────────────────────────────────────────────────
  const briefing = require('../src/weather/briefing');
  const txt = briefing.render({ generated_at: '2026-10-18T12:00:00Z', location: { label: 'Moore, OK', nws_place: 'Moore, OK', office: 'OUN' }, alerts: [{ event: 'Tornado Warning', headline: 'HEADLINE', expires: '2026-10-18T13:00:00Z', tornado_detection: 'OBSERVED' }],
    now: { source: 'NWS observation', station: 'Will Rogers', time: '2026-10-18T11:55:00Z', text: 'Thunderstorm', temp_f: 78, feels_f: 81, humidity: 70, wind_compass: 'S', wind_mph: 25, gust_mph: 40, pressure_inhg: 29.6 },
    next_24h: { high_f: 80, low_f: 60, max_precip_chance: 90, precip_in: 1.2, snow_in: 0, max_gust_mph: 45, conditions: ['Thunderstorm'] }, nws_periods: [], week: [], air_quality: null, severe_risk_today: { category_label: 'Moderate risk (4/5)', tornado: { label: '15%' } }, tropical: [], quakes_recent: [], rivers_in_flood: [], tides: null, newsroom: { headlines: [{ headline: 'Tornado hits Moore', source: 'ap', url: 'https://x', credibility: 80 }], trends: [] } });
  assert(/WEATHER BRIEFING — Moore, OK/.test(txt) && /Tornado Warning — HEADLINE \(until .*\) \[OBSERVED\]/.test(txt) && /SEVERE RISK TODAY.*Moderate risk.*tornado 15%/.test(txt) && /Tornado hits Moore — ap, credibility 80/.test(txt), 'briefing text carries alerts, risk and newsroom coverage');

  setFetch(null); clearCache();
};
