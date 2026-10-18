// Small geographic toolkit: distances, point-in-polygon over GeoJSON,
// bounding boxes, unit conversions, compass points. No dependencies.

const R_KM = 6371;
const rad = d => d * Math.PI / 180;

function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(a));
}

// Ray casting over one linear ring of [lon, lat] pairs.
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lon, lat, polygon) {   // polygon = [outer, hole, hole…]
  if (!polygon || !polygon.length || !pointInRing(lon, lat, polygon[0])) return false;
  for (let k = 1; k < polygon.length; k++) if (pointInRing(lon, lat, polygon[k])) return false;
  return true;
}

// GeoJSON geometry (Polygon | MultiPolygon | GeometryCollection) contains point?
function pointInGeometry(geometry, lat, lon) {
  if (!geometry) return false;
  switch (geometry.type) {
    case 'Polygon': return pointInPolygon(lon, lat, geometry.coordinates);
    case 'MultiPolygon': return geometry.coordinates.some(p => pointInPolygon(lon, lat, p));
    case 'GeometryCollection': return (geometry.geometries || []).some(g => pointInGeometry(g, lat, lon));
    default: return false;
  }
}

// [minLon, minLat, maxLon, maxLat] of any geometry; null when it has none.
function bboxOf(geometry) {
  let b = null;
  const visit = c => {
    if (typeof c[0] === 'number') {
      if (!b) b = [c[0], c[1], c[0], c[1]];
      else { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); }
    } else for (const x of c) visit(x);
  };
  if (!geometry) return null;
  if (geometry.type === 'GeometryCollection') (geometry.geometries || []).forEach(g => { const gb = bboxOf(g); if (gb) visit([[gb[0], gb[1]], [gb[2], gb[3]]]); });
  else if (geometry.coordinates) visit(geometry.coordinates);
  return b;
}

function centroidOf(geometry) {
  const b = bboxOf(geometry);
  return b ? { lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2 } : null;
}

// "lat,lon" → { lat, lon } or null.
function parseLatLon(s) {
  const m = String(s || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function compass(deg) {
  if (deg == null || !Number.isFinite(deg)) return null;
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

const cToF = c => c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10;
const fToC = f => f == null ? null : Math.round(((f - 32) * 5 / 9) * 10) / 10;
const kmhToMph = k => k == null ? null : Math.round(k * 0.621371 * 10) / 10;
const msToMph = m => m == null ? null : Math.round(m * 2.23694 * 10) / 10;
const kmToMi = k => k == null ? null : Math.round(k * 0.621371 * 10) / 10;
const mmToIn = mm => mm == null ? null : Math.round(mm / 25.4 * 100) / 100;
const paToInHg = pa => pa == null ? null : Math.round(pa * 0.0002953 * 100) / 100;
const hpaToInHg = h => h == null ? null : Math.round(h * 0.02953 * 100) / 100;

// Nearest N items with lat/lon fields to a point, annotated with km.
function nearest(items, lat, lon, n = 5, getLatLon = x => [x.lat, x.lon]) {
  return items
    .map(x => { const [la, lo] = getLatLon(x); return { item: x, km: (la == null || lo == null) ? Infinity : haversineKm(lat, lon, la, lo) }; })
    .filter(x => Number.isFinite(x.km))
    .sort((a, b) => a.km - b.km)
    .slice(0, n);
}

module.exports = {
  haversineKm, pointInRing, pointInPolygon, pointInGeometry, bboxOf, centroidOf, parseLatLon, compass,
  cToF, fToC, kmhToMph, msToMph, kmToMi, mmToIn, paToInHg, hpaToInHg, nearest,
};
