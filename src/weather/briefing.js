// The briefing — what a Newsroom Reporter reads before writing.
//
// One location in, one structured block out: who/where, what is in effect
// (alerts, with expiry), what it is doing now (observation), what is coming
// (next 24h and 7 days), what else is in play (SPC risk, tropical systems,
// rivers in flood, recent quakes, air quality, tides), and what the newsroom
// has already published about the place. Also rendered as plain text, the
// shape the reporters' prompts consume.

const alerts = require('./alerts');
const forecast = require('./forecast');
const spc = require('./spc');
const tropical = require('./tropical');
const quakes = require('./quakes');
const hazards = require('./hazards');
const tides = require('./tides');
const geo = require('../geo');

const settle = p => p.then(v => ({ ok: true, v }), e => ({ ok: false, e: e.message }));

async function build({ lat, lon, label, newsroomMirror, newsroomEvents }) {
  const cond = await forecast.conditions(lat, lon, { hours: 24, days: 7 });
  const zoneIds = cond.nws && cond.nws.point ? [cond.nws.point.zone, cond.nws.point.county, cond.nws.point.fire_zone].filter(Boolean).map(z => `https://api.weather.gov/zones/${z.startsWith(z.slice(0, 2) + 'C') ? 'county' : 'forecast'}/${z}`) : [];
  const [al, risk, storms, qk, rivers, tide] = await Promise.all([
    settle(alerts.atPoint(lat, lon, { zoneIds: [...zoneIds, ...zoneIds.map(z => z.replace('/forecast/', '/fire/'))] })),
    settle(spc.riskAt(lat, lon, 1)),
    settle(tropical.near(lat, lon, 1200)),
    settle(quakes.near(lat, lon, { km: 300, feed: '2.5_week' })),
    settle(hazards.flooding({ lat, lon, km: 150 })),
    settle(tides.near(lat, lon, 60)),
  ]);

  const om = cond.open_meteo && !cond.open_meteo.error ? cond.open_meteo : null;
  const obs = cond.nws && cond.nws.observation;
  const next24 = om ? om.hourly.filter(h => Date.parse(h.time) >= Date.now()).slice(0, 24) : [];
  const hi = next24.length ? Math.max(...next24.map(h => h.temp_f)) : null;
  const lo = next24.length ? Math.min(...next24.map(h => h.temp_f)) : null;
  const maxGust = next24.length ? Math.max(...next24.map(h => h.gust_mph || 0)) : null;
  const maxPop = next24.length ? Math.max(...next24.map(h => h.precip_chance || 0)) : null;
  const precipIn = next24.length ? +next24.reduce((s, h) => s + (h.precip_in || 0), 0).toFixed(2) : null;
  const snowIn = next24.length ? +next24.reduce((s, h) => s + (h.snow_in || 0), 0).toFixed(1) : null;

  // Newsroom coverage: headlines naming the place or its state, newest first.
  const terms = [label, cond.nws && cond.nws.point && cond.nws.point.place].filter(Boolean).flatMap(s => String(s).split(',')[0].trim().toLowerCase().split(/\s+/)).filter(w => w.length > 3);
  const state = cond.nws && cond.nws.point && cond.nws.point.place ? cond.nws.point.place.split(',').pop().trim() : null;
  const news = newsroomMirror ? newsroomMirror.query({ limit: 12, pred: r => { const t = `${r.headline} ${r.snippet || ''}`.toLowerCase(); return terms.some(w => t.includes(w)) || (state && new RegExp(`\\b${state}\\b`).test(`${r.headline} ${r.snippet || ''}`)); } }) : [];
  const events = (newsroomEvents || []).slice(0, 8);

  const b = {
    generated_at: new Date().toISOString(),
    location: { label, lat, lon, nws_place: cond.nws && cond.nws.point ? cond.nws.point.place : null, office: cond.nws && cond.nws.point ? cond.nws.point.office : null, timezone: om ? om.timezone : null },
    alerts: al.ok ? al.v.alerts : [], alerts_error: al.ok ? null : al.e,
    now: obs ? { time: obs.time, text: obs.text, temp_f: geo.cToF(obs.temp_c), feels_f: geo.cToF(obs.heat_index_c ?? obs.wind_chill_c ?? obs.temp_c), dewpoint_f: geo.cToF(obs.dewpoint_c), humidity: obs.humidity != null ? Math.round(obs.humidity) : null, wind_mph: geo.kmhToMph(obs.wind_kmh), gust_mph: geo.kmhToMph(obs.gust_kmh), wind_compass: geo.compass(obs.wind_dir), pressure_inhg: geo.paToInHg(obs.sea_level_pa ?? obs.pressure_pa), visibility_mi: obs.visibility_m != null ? geo.kmToMi(obs.visibility_m / 1000) : null, station: obs.station_name, source: 'NWS observation' }
      : om ? { time: om.current.time, text: om.current.weather.text, temp_f: om.current.temp_f, feels_f: om.current.feels_f, humidity: om.current.humidity, wind_mph: om.current.wind_mph, gust_mph: om.current.gust_mph, wind_compass: om.current.wind_compass, pressure_inhg: geo.hpaToInHg(om.current.pressure_hpa), source: 'Open-Meteo model analysis' } : null,
    next_24h: next24.length ? { high_f: hi, low_f: lo, max_precip_chance: maxPop, precip_in: precipIn, snow_in: snowIn, max_gust_mph: maxGust, conditions: [...new Set(next24.map(h => h.weather.text))].slice(0, 4) } : null,
    nws_periods: cond.nws && cond.nws.forecast ? cond.nws.forecast.periods.slice(0, 6).map(p => ({ name: p.name, temp: `${p.temp}°${p.temp_unit}`, precip_chance: p.precip_chance, wind: `${p.wind} ${p.wind_dir}`, detailed: p.detailed })) : [],
    week: om ? om.daily.map(d => ({ date: d.date, text: d.weather.text, high_f: d.high_f, low_f: d.low_f, precip_chance: d.precip_chance, precip_in: d.precip_in, snow_in: d.snow_in, gust_max_mph: d.gust_max_mph, sunrise: d.sunrise, sunset: d.sunset })) : [],
    air_quality: cond.air_quality && !cond.air_quality.error ? cond.air_quality.current : null,
    severe_risk_today: risk.ok ? risk.v : null,
    tropical: storms.ok ? storms.v : [],
    quakes_recent: qk.ok ? qk.v.slice(0, 5) : [],
    rivers_in_flood: rivers.ok ? rivers.v.gauges.slice(0, 8) : [],
    tides: tide.ok && tide.v.coastal ? { station: tide.v.station.name, next: tide.v.next, water_level: tide.v.water_level } : null,
    newsroom: { headlines: news.map(r => ({ headline: r.headline, source: r.source, url: r.url, published_at: r.published_at, credibility: r.credibility, classes: r.classes })), trends: events.map(e => ({ subject: e.label || e.subject, count: e.count, z: e.z, sources: e.sources })) },
  };
  b.text = render(b);
  return b;
}

const f = v => v == null ? '—' : v;
const when = iso => { try { return new Date(iso).toUTCString().replace(':00 GMT', ' UTC'); } catch { return iso; } };

function render(b) {
  const L = [];
  L.push(`WEATHER BRIEFING — ${b.location.label}${b.location.nws_place && b.location.nws_place !== b.location.label ? ` (${b.location.nws_place})` : ''}`);
  L.push(`Generated ${when(b.generated_at)}${b.location.office ? ` · NWS office ${b.location.office}` : ''}`);
  L.push('');
  L.push(`ALERTS IN EFFECT (${b.alerts.length})`);
  if (!b.alerts.length) L.push('  none');
  for (const a of b.alerts) L.push(`  • ${a.event} — ${a.headline || a.area}${a.expires ? ` (until ${when(a.expires)})` : ''}${a.tornado_detection ? ` [${a.tornado_detection}]` : ''}`);
  L.push('');
  if (b.now) {
    L.push(`NOW (${b.now.source}${b.now.station ? `, ${b.now.station}` : ''}, ${when(b.now.time)})`);
    L.push(`  ${f(b.now.text)} · ${f(b.now.temp_f)}°F${b.now.feels_f != null && b.now.feels_f !== b.now.temp_f ? ` (feels ${b.now.feels_f}°F)` : ''} · humidity ${f(b.now.humidity)}% · wind ${f(b.now.wind_compass)} ${f(b.now.wind_mph)} mph${b.now.gust_mph ? ` gusting ${b.now.gust_mph}` : ''} · pressure ${f(b.now.pressure_inhg)} inHg${b.now.visibility_mi != null ? ` · visibility ${b.now.visibility_mi} mi` : ''}`);
    L.push('');
  }
  if (b.next_24h) {
    L.push('NEXT 24 HOURS');
    L.push(`  high ${f(b.next_24h.high_f)}°F · low ${f(b.next_24h.low_f)}°F · precip chance up to ${f(b.next_24h.max_precip_chance)}% (${f(b.next_24h.precip_in)} in${b.next_24h.snow_in ? `, snow ${b.next_24h.snow_in} in` : ''}) · gusts to ${f(b.next_24h.max_gust_mph)} mph · ${b.next_24h.conditions.join(', ')}`);
    L.push('');
  }
  if (b.nws_periods.length) {
    L.push('NWS FORECAST');
    for (const p of b.nws_periods) L.push(`  ${p.name}: ${p.detailed}`);
    L.push('');
  }
  if (b.week.length) {
    L.push('7-DAY');
    for (const d of b.week) L.push(`  ${d.date}: ${d.text}, ${f(d.high_f)}/${f(d.low_f)}°F, precip ${f(d.precip_chance)}%${d.precip_in ? ` (${d.precip_in} in)` : ''}${d.snow_in ? `, snow ${d.snow_in} in` : ''}, gusts ${f(d.gust_max_mph)} mph`);
    L.push('');
  }
  if (b.severe_risk_today) L.push(`SEVERE RISK TODAY (SPC Day 1): ${b.severe_risk_today.category_label}${b.severe_risk_today.tornado ? ` · tornado ${b.severe_risk_today.tornado.label}` : ''}${b.severe_risk_today.wind ? ` · wind ${b.severe_risk_today.wind.label}` : ''}${b.severe_risk_today.hail ? ` · hail ${b.severe_risk_today.hail.label}` : ''}`);
  if (b.air_quality && b.air_quality.aqi != null) L.push(`AIR QUALITY: US AQI ${b.air_quality.aqi} (${b.air_quality.band ? b.air_quality.band.label : ''}) · PM2.5 ${f(b.air_quality.pm2_5)} µg/m³ · ozone ${f(b.air_quality.o3)} µg/m³`);
  if (b.tropical.length) { L.push('TROPICAL SYSTEMS WITHIN 1,200 KM'); for (const s of b.tropical) L.push(`  • ${s.classification || ''} ${s.name}: ${s.category ? s.category.label : ''}, ${f(s.wind_mph)} mph, ${f(s.pressure_mb)} mb, moving ${f(s.movement.compass)} at ${f(s.movement.speed_mph)} mph, ${s.distance_mi} mi away`); }
  if (b.rivers_in_flood.length) { L.push('RIVERS AT OR ABOVE FLOOD STAGE WITHIN 150 KM'); for (const g of b.rivers_in_flood) L.push(`  • ${g.name} (${g.id}): ${g.observed.category} — ${f(g.observed.stage)} ${g.observed.unit || 'ft'}${g.forecast && g.forecast.category ? `, forecast ${g.forecast.category}` : ''}`); }
  if (b.quakes_recent.length) { L.push('EARTHQUAKES M2.5+ WITHIN 300 KM, PAST 7 DAYS'); for (const q of b.quakes_recent) L.push(`  • M${q.mag} ${q.place} (${when(q.time)}, ${q.distance_mi} mi away)`); }
  if (b.tides) L.push(`TIDES (${b.tides.station}): next ${b.tides.next ? `${b.tides.next.type} tide ${b.tides.next.height_ft} ft at ${b.tides.next.time}` : 'n/a'}${b.tides.water_level ? ` · observed ${b.tides.water_level.height_ft} ft` : ''}`);
  L.push('');
  L.push(`NEWSROOM COVERAGE (${b.newsroom.headlines.length} recent)`);
  if (!b.newsroom.headlines.length) L.push('  none matching this place yet');
  for (const h of b.newsroom.headlines) L.push(`  • ${h.headline} — ${h.source}${h.credibility != null ? `, credibility ${h.credibility}` : ''} (${h.url})`);
  if (b.newsroom.trends.length) { L.push('TRENDING ON THE WEATHER DESK'); for (const t of b.newsroom.trends) L.push(`  • ${t.subject}: ${t.count} stories, z=${t.z}, ${(t.sources || []).join(', ')}`); }
  return L.join('\n');
}

module.exports = { build, render };
