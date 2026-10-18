// NWS active alerts (api.weather.gov). The alert IS the event — these are
// primary sources, the same standing SEC filings have on the finance desk.
//
// One national pull every 90 seconds (the API asks for a 60s minimum),
// normalized once, then every question (by state, by point, by event, by
// severity, a single id) is answered from memory.

const { fetchJson, cached } = require('../fetch');
const { pointInGeometry, bboxOf, centroidOf } = require('../geo');

const ACTIVE_URL = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update';
const TTL = 90 * 1000;

// Official NWS product colors (the map legend everyone recognizes).
const COLORS = {
  'Tornado Warning': '#FF0000', 'Tornado Watch': '#FFFF00', 'Severe Thunderstorm Warning': '#FFA500',
  'Severe Thunderstorm Watch': '#DB7093', 'Flash Flood Warning': '#8B0000', 'Flash Flood Watch': '#2E8B57',
  'Flood Warning': '#00FF00', 'Flood Watch': '#2E8B57', 'Flood Advisory': '#00FF7F', 'Hurricane Warning': '#DC143C',
  'Hurricane Watch': '#FF00FF', 'Tropical Storm Warning': '#B22222', 'Tropical Storm Watch': '#F08080',
  'Storm Surge Warning': '#B524F7', 'Storm Surge Watch': '#DB7FF7', 'Extreme Wind Warning': '#FF8C00',
  'Winter Storm Warning': '#FF69B4', 'Winter Storm Watch': '#4682B4', 'Blizzard Warning': '#FF4500',
  'Ice Storm Warning': '#8B008B', 'Winter Weather Advisory': '#7B68EE', 'Wind Chill Warning': '#B0C4DE',
  'Extreme Cold Warning': '#0000FF', 'Cold Weather Advisory': '#AFEEEE', 'Freeze Warning': '#483D8B',
  'Frost Advisory': '#6495ED', 'Excessive Heat Warning': '#C71585', 'Extreme Heat Warning': '#C71585',
  'Heat Advisory': '#FF7F50', 'Red Flag Warning': '#FF1493', 'Fire Weather Watch': '#FFDEAD',
  'High Wind Warning': '#DAA520', 'High Wind Watch': '#B8860B', 'Wind Advisory': '#D2B48C',
  'Dense Fog Advisory': '#708090', 'Air Quality Alert': '#808080', 'Coastal Flood Warning': '#228B22',
  'Coastal Flood Advisory': '#7CFC00', 'Coastal Flood Watch': '#66CDAA', 'Gale Warning': '#DDA0DD',
  'Storm Warning': '#9400D3', 'Small Craft Advisory': '#D8BFD8', 'Special Weather Statement': '#FFE4B5',
  'Hazardous Weather Outlook': '#EEE8AA', 'Tsunami Warning': '#FD6347', 'Tsunami Advisory': '#D2691E',
  'Avalanche Warning': '#1E90FF', 'Dust Storm Warning': '#FFE4C4', 'Lake Effect Snow Warning': '#008B8B',
  'Rip Current Statement': '#40E0D0', 'Beach Hazards Statement': '#40E0D0', 'Hard Freeze Warning': '#9400D3',
};
const SEVERITY_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };
// "Life-threatening, happening now" first on every list.
const PRIORITY = [
  'Tornado Warning', 'Extreme Wind Warning', 'Flash Flood Emergency', 'Tsunami Warning', 'Hurricane Warning',
  'Storm Surge Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning', 'Blizzard Warning', 'Ice Storm Warning',
  'Tropical Storm Warning', 'Tornado Watch', 'Red Flag Warning', 'Winter Storm Warning', 'Extreme Heat Warning',
  'Excessive Heat Warning', 'Extreme Cold Warning', 'High Wind Warning', 'Flood Warning', 'Severe Thunderstorm Watch',
];

const stateOfUgc = ugc => (String(ugc || '').match(/^([A-Z]{2})[CZ]\d{3}$/) || [])[1] || null;

function normalize(f) {
  const p = f.properties || {};
  const params = p.parameters || {};
  const ugc = (p.geocode && p.geocode.UGC) || [];
  const states = [...new Set(ugc.map(stateOfUgc).filter(Boolean))];
  const geometry = f.geometry || null;
  const bbox = bboxOf(geometry);
  const headline = (params.NWSheadline && params.NWSheadline[0]) || p.headline || p.event;
  const isEmergency = /emergency/i.test(String(p.description || '').slice(0, 400)) && /flash flood|tornado/i.test(p.event || '');
  return {
    id: p.id || f.id,
    event: p.event,
    event_key: isEmergency ? `${p.event} (Emergency)` : p.event,
    severity: p.severity || 'Unknown',
    urgency: p.urgency || 'Unknown',
    certainty: p.certainty || 'Unknown',
    category: p.category || null,
    message_type: p.messageType || null,
    status: p.status || null,
    headline,
    area: p.areaDesc || '',
    states,
    ugc,
    zones: p.affectedZones || [],
    sender: p.senderName || null,
    office: (String(p.id || '').match(/\.([A-Z]{4})\./) || [])[1] || null,
    sent: p.sent || null,
    effective: p.effective || null,
    onset: p.onset || null,
    expires: p.expires || null,
    ends: p.ends || null,
    description: p.description || '',
    instruction: p.instruction || '',
    response: p.response || null,
    vtec: (params.VTEC && params.VTEC[0]) || null,
    tornado_detection: (params.tornadoDetection && params.tornadoDetection[0]) || null,
    tornado_damage_threat: (params.tornadoDamageThreat && params.tornadoDamageThreat[0]) || null,
    thunderstorm_damage_threat: (params.thunderstormDamageThreat && params.thunderstormDamageThreat[0]) || null,
    flash_flood_damage_threat: (params.flashFloodDamageThreat && params.flashFloodDamageThreat[0]) || null,
    max_wind_gust: (params.maxWindGust && params.maxWindGust[0]) || null,
    max_hail_size: (params.maxHailSize && params.maxHailSize[0]) || null,
    color: COLORS[p.event] || '#9E9E9E',
    severity_rank: SEVERITY_RANK[p.severity] ?? 0,
    priority: PRIORITY.indexOf(isEmergency ? `${p.event.replace(' Warning', '')} Emergency` : p.event),
    has_geometry: Boolean(geometry),
    bbox,
    centroid: centroidOf(geometry),
    geometry,   // kept for the map and point lookups; stripped from list replies
  };
}

function rank(a, b) {
  const pa = a.priority === -1 ? 99 : a.priority, pb = b.priority === -1 ? 99 : b.priority;
  if (pa !== pb) return pa - pb;
  if (a.severity_rank !== b.severity_rank) return b.severity_rank - a.severity_rank;
  return String(b.sent).localeCompare(String(a.sent));
}

async function load() {
  return cached('nws:alerts', TTL, async () => {
    const j = await fetchJson(ACTIVE_URL, { source: 'nws-alerts', timeout: 20000 });
    const alerts = (j.features || []).map(normalize).sort(rank);
    return { alerts, updated: j.updated || new Date().toISOString() };
  }, { staleMs: 30 * 60 * 1000 });
}

// Lean copy for lists (no polygon, truncated text).
function lean(a) {
  const { geometry, description, instruction, ...rest } = a;
  return { ...rest, description_preview: String(description).replace(/\s+/g, ' ').slice(0, 280) };
}

async function list({ state, event, severity, urgency, q, limit = 500, point } = {}) {
  const { data, fetched_at, stale, error } = await load();
  let rows = data.alerts;
  if (state) { const S = state.toUpperCase(); rows = rows.filter(a => a.states.includes(S)); }
  if (event) { const E = event.toLowerCase(); rows = rows.filter(a => a.event.toLowerCase().includes(E)); }
  if (severity) rows = rows.filter(a => a.severity === severity);
  if (urgency) rows = rows.filter(a => a.urgency === urgency);
  if (q) { const needle = q.toLowerCase(); rows = rows.filter(a => `${a.event} ${a.area} ${a.headline}`.toLowerCase().includes(needle)); }
  if (point) rows = rows.filter(a => a.has_geometry ? pointInGeometry(a.geometry, point.lat, point.lon) : false);
  return { updated: data.updated, fetched_at, stale, error, total: rows.length, alerts: rows.slice(0, limit).map(lean) };
}

async function byId(id) {
  const { data } = await load();
  return data.alerts.find(a => a.id === id) || null;
}

// Alerts covering a point: polygon alerts by geometry, zone/county alerts by
// the point's NWS zone + county (the caller passes them from /points).
async function atPoint(lat, lon, { zoneIds = [] } = {}) {
  const { data, fetched_at, stale } = await load();
  const zones = new Set(zoneIds);
  const rows = data.alerts.filter(a =>
    (a.has_geometry && pointInGeometry(a.geometry, lat, lon)) ||
    (!a.has_geometry && a.zones.some(z => zones.has(z))));
  return { fetched_at, stale, alerts: rows.map(lean) };
}

// GeoJSON of polygon alerts for the map (zone-only alerts have no shape).
async function geojson({ state, event } = {}) {
  const { data } = await load();
  let rows = data.alerts.filter(a => a.has_geometry);
  if (state) { const S = state.toUpperCase(); rows = rows.filter(a => a.states.includes(S)); }
  if (event) { const E = event.toLowerCase(); rows = rows.filter(a => a.event.toLowerCase().includes(E)); }
  return {
    type: 'FeatureCollection',
    features: rows.map(a => ({
      type: 'Feature', geometry: a.geometry,
      properties: { id: a.id, event: a.event, severity: a.severity, headline: a.headline, area: a.area, expires: a.expires, color: a.color, tornado_detection: a.tornado_detection, max_wind_gust: a.max_wind_gust, max_hail_size: a.max_hail_size },
    })),
  };
}

// The national picture: counts by event, by state, by severity; the
// life-threatening ones listed; what expires soonest.
async function summary() {
  const { data, fetched_at, stale, error } = await load();
  const byEvent = {}, byState = {}, bySeverity = {};
  for (const a of data.alerts) {
    byEvent[a.event_key] = (byEvent[a.event_key] || 0) + 1;
    bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
    for (const s of a.states) byState[s] = (byState[s] || 0) + 1;
  }
  const events = Object.entries(byEvent).map(([event, count]) => ({ event, count, color: COLORS[event.replace(' (Emergency)', '')] || '#9E9E9E', priority: PRIORITY.indexOf(event) }))
    .sort((a, b) => (a.priority === -1 ? 99 : a.priority) - (b.priority === -1 ? 99 : b.priority) || b.count - a.count);
  const urgent = data.alerts.filter(a => a.priority !== -1 && a.priority <= 10).slice(0, 40).map(lean);
  return {
    updated: data.updated, fetched_at, stale, error,
    total: data.alerts.length,
    warnings: data.alerts.filter(a => /warning/i.test(a.event)).length,
    watches: data.alerts.filter(a => /watch/i.test(a.event)).length,
    advisories: data.alerts.filter(a => /advisory|statement/i.test(a.event)).length,
    tornado_warnings: byEvent['Tornado Warning'] || 0,
    tornado_emergencies: byEvent['Tornado Warning (Emergency)'] || 0,
    flash_flood_emergencies: byEvent['Flash Flood Warning (Emergency)'] || 0,
    by_event: events,
    by_state: Object.entries(byState).map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count),
    by_severity: bySeverity,
    urgent,
  };
}

module.exports = { load, list, byId, atPoint, geojson, summary, normalize, COLORS, PRIORITY, stateOfUgc };
