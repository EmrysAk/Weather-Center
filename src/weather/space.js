// Space weather — NOAA Space Weather Prediction Center (keyless JSON).
// Geomagnetic storms knock out GPS and power grids and light up auroras;
// a weather desk gets asked about all three.

const { fetchJson, fetchText, cached } = require('../fetch');

const MIN = 60 * 1000;
const S = 'https://services.swpc.noaa.gov';

const G_SCALE = kp => kp >= 9 ? 'G5 extreme' : kp >= 8 ? 'G4 severe' : kp >= 7 ? 'G3 strong' : kp >= 6 ? 'G2 moderate' : kp >= 5 ? 'G1 minor' : kp >= 4 ? 'active' : kp >= 3 ? 'unsettled' : 'quiet';
const G_COLOR = kp => kp >= 7 ? '#FF0000' : kp >= 5 ? '#FFA500' : kp >= 4 ? '#FFFF00' : '#00C853';

async function summary() {
  const parts = await Promise.allSettled([
    cached('swpc:kp', 15 * MIN, async () => {
      const rows = await fetchJson(`${S}/products/noaa-planetary-k-index.json`, { source: 'swpc' });
      // Two shapes seen from SWPC: a header row + arrays, or objects.
      const list = Array.isArray(rows) ? rows : [];
      const parsed = list.map(r => Array.isArray(r)
        ? { time: r[0], kp: parseFloat(r[1]), a_running: r[2] != null ? parseFloat(r[2]) : null, station_count: r[3] != null ? parseInt(r[3], 10) : null }
        : { time: r.time_tag, kp: parseFloat(r.kp_index ?? r.Kp ?? r.kp), a_running: r.a_running != null ? parseFloat(r.a_running) : null, station_count: r.station_count != null ? parseInt(r.station_count, 10) : null });
      return parsed.filter(x => x.time && Number.isFinite(x.kp)).slice(-96);
    }),
    cached('swpc:alerts', 10 * MIN, async () => {
      const rows = await fetchJson(`${S}/products/alerts.json`, { source: 'swpc' });
      return rows.slice(0, 25).map(a => ({ issued: a.issue_datetime, product: a.product_id, message: String(a.message || '').trim() }));
    }),
    cached('swpc:3day', 60 * MIN, async () => fetchText(`${S}/text/3-day-forecast.txt`, { source: 'swpc' })),
    cached('swpc:scales', 15 * MIN, async () => fetchJson(`${S}/products/noaa-scales.json`, { source: 'swpc' })),
    cached('swpc:wind', 10 * MIN, async () => {
      // Real-time solar wind (DSCOVR/ACE), newest first.
      const rows = await fetchJson(`${S}/json/rtsw/rtsw_wind_1m.json`, { source: 'swpc' });
      const last = (Array.isArray(rows) ? rows : []).find(r => r && r.proton_speed != null) || {};
      return { time: last.time_tag || null, density: last.proton_density != null ? parseFloat(last.proton_density) : null, speed_kms: last.proton_speed != null ? parseFloat(last.proton_speed) : null, temperature_k: last.proton_temperature != null ? parseFloat(last.proton_temperature) : null, source: last.source || null };
    }),
  ]);
  const [kp, alerts, forecast, scales, wind] = parts.map(p => p.status === 'fulfilled' ? p.value.data : null);
  const latestKp = kp && kp.length ? kp[kp.length - 1] : null;
  const now = scales && scales['0'] ? scales['0'] : null;
  return {
    kp: { latest: latestKp, scale: latestKp ? G_SCALE(latestKp.kp) : null, color: latestKp ? G_COLOR(latestKp.kp) : null, history: kp || [] },
    scales_now: now ? { geomagnetic: now.G, radiation: now.S, radio_blackout: now.R, date: now.DateStamp } : null,
    solar_wind: wind,
    alerts: alerts || [],
    forecast_text: forecast || null,
    errors: parts.filter(p => p.status === 'rejected').map(p => p.reason.message),
  };
}

module.exports = { summary, G_SCALE };
