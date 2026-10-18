// Radar + satellite imagery sources for the map.
//
//   RainViewer   keyless tile API: the last ~2h of composite radar frames
//                plus a short nowcast, and infrared satellite frames. The
//                browser loads tiles straight from their CDN; this module
//                just hands it the frame list and URL templates.
//   NWS RIDGE    national + regional radar loop GIFs as a no-JS fallback.

const { fetchJson, cached } = require('../fetch');

const MIN = 60 * 1000;

const NWS_REGIONS = {
  CONUS: 'Continental US', NORTHEAST: 'Northeast', SOUTHEAST: 'Southeast', CENTGRLAKES: 'Central Great Lakes', SOUTHMISSVLY: 'Southern Mississippi Valley',
  NORTHROCKIES: 'Northern Rockies', SOUTHROCKIES: 'Southern Rockies', PACNORTHWEST: 'Pacific Northwest', PACSOUTHWEST: 'Pacific Southwest',
  UPPERMISSVLY: 'Upper Mississippi Valley', SOUTHPLAINS: 'Southern Plains', NORTHPLAINS: 'Northern Plains', ALASKA: 'Alaska', HAWAII: 'Hawaii', CARIB: 'Caribbean',
};

async function frames() {
  const { data, fetched_at, stale, error } = await cached('rainviewer:maps', 5 * MIN, async () => {
    const j = await fetchJson('https://api.rainviewer.com/public/weather-maps.json', { source: 'rainviewer' });
    const host = j.host || 'https://tilecache.rainviewer.com';
    const radar = j.radar || {};
    return {
      host, generated: j.generated ? new Date(j.generated * 1000).toISOString() : null,
      radar: {
        past: (radar.past || []).map(f => ({ time: new Date(f.time * 1000).toISOString(), path: f.path })),
        nowcast: (radar.nowcast || []).map(f => ({ time: new Date(f.time * 1000).toISOString(), path: f.path })),
      },
      satellite: { infrared: ((j.satellite || {}).infrared || []).map(f => ({ time: new Date(f.time * 1000).toISOString(), path: f.path })) },
      // {path}/{size}/{z}/{x}/{y}/{color}/{options}.png — color 4 = Universal Blue, 6 = NEXRAD-like; options smooth_snow
      tile_template: '{host}{path}/256/{z}/{x}/{y}/{color}/{options}.png',
      colors: { universal_blue: 4, titan: 1, weather_channel: 2, meteored: 3, dark_sky: 5, nexrad: 6, rainbow: 7, 'rainbow_selex': 8 },
      satellite_template: '{host}{path}/256/{z}/{x}/{y}/0/0_0.png',
    };
  }, { staleMs: 60 * MIN });
  return { fetched_at, stale, error, ...data, nws: { regions: NWS_REGIONS, loop: 'https://radar.weather.gov/ridge/standard/{region}_loop.gif', still: 'https://radar.weather.gov/ridge/standard/{region}_0.gif', station_loop: 'https://radar.weather.gov/ridge/standard/{station}_loop.gif' } };
}

module.exports = { frames, NWS_REGIONS };
