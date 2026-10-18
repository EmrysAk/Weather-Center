// Conditions and forecasts for a point.
//
// Two sources, merged:
//   NWS (api.weather.gov)  — US only: the official 7-day periods with their
//                            narrative text, hourly grid, nearest station's
//                            latest observation, the point's forecast zone
//                            + county (what zone-based alerts key on).
//   Open-Meteo              — global, keyless: hourly and daily numbers for
//                            charts (temperature, feels-like, precipitation
//                            probability/amount, wind + gusts, humidity, dew
//                            point, cloud cover, UV, visibility, pressure,
//                            snow), sunrise/sunset, and the air-quality model
//                            (US AQI, PM2.5, PM10, O3, NO2, SO2, CO).
//
// Everything is cached: NWS point metadata a day, forecasts 15 minutes,
// observations 10 minutes, Open-Meteo 15 minutes.

const { fetchJson, cached } = require('../fetch');
const geo = require('../geo');

const MIN = 60 * 1000;
const NWS = 'https://api.weather.gov';

// ─── WMO weather codes (Open-Meteo) → text + glyph ───────────────────
const WMO = {
  0: ['Clear', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Rime fog', '🌫️'], 51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Heavy freezing drizzle', '🌧️'], 61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Heavy freezing rain', '🌧️'], 71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'], 80: ['Rain showers', '🌦️'], 81: ['Heavy showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Heavy snow showers', '❄️'], 95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm with hail', '⛈️'], 99: ['Severe thunderstorm with hail', '⛈️'],
};
const wmo = code => ({ code, text: (WMO[code] || ['Unknown', '•'])[0], glyph: (WMO[code] || ['Unknown', '•'])[1] });

// ─── NWS ─────────────────────────────────────────────────────────────
async function nwsPoint(lat, lon) {
  const key = `nws:point:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const { data } = await cached(key, 24 * 60 * MIN, async () => {
    const j = await fetchJson(`${NWS}/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { source: 'nws-points' });
    const p = j.properties || {};
    const rl = (p.relativeLocation && p.relativeLocation.properties) || {};
    return {
      office: p.cwa || p.gridId || null,
      grid: { id: p.gridId, x: p.gridX, y: p.gridY },
      forecast_url: p.forecast, hourly_url: p.forecastHourly, stations_url: p.observationStations,
      zone: p.forecastZone ? p.forecastZone.split('/').pop() : null,
      county: p.county ? p.county.split('/').pop() : null,
      fire_zone: p.fireWeatherZone ? p.fireWeatherZone.split('/').pop() : null,
      timezone: p.timeZone || null,
      radar_station: p.radarStation || null,
      place: rl.city ? `${rl.city}, ${rl.state}` : null,
    };
  });
  return data;
}

const windMph = s => { const m = String(s || '').match(/(\d+)(?:\s*to\s*(\d+))?\s*mph/); return m ? parseInt(m[2] || m[1], 10) : null; };

async function nwsForecast(point) {
  if (!point.forecast_url) return null;
  const { data, stale } = await cached(`nws:forecast:${point.forecast_url}`, 15 * MIN, async () => {
    const j = await fetchJson(point.forecast_url, { source: 'nws-forecast' });
    const p = j.properties || {};
    return {
      generated_at: p.generatedAt || null, updated_at: p.updateTime || null, elevation_m: p.elevation && p.elevation.value,
      periods: (p.periods || []).map(x => ({
        name: x.name, start: x.startTime, end: x.endTime, is_daytime: x.isDaytime,
        temp: x.temperature, temp_unit: x.temperatureUnit, temp_trend: x.temperatureTrend || null,
        precip_chance: x.probabilityOfPrecipitation && x.probabilityOfPrecipitation.value,
        wind: x.windSpeed, wind_mph: windMph(x.windSpeed), wind_dir: x.windDirection, icon: x.icon,
        short: x.shortForecast, detailed: x.detailedForecast,
      })),
    };
  });
  return { ...data, stale };
}

async function nwsHourly(point, hours = 48) {
  if (!point.hourly_url) return null;
  const { data, stale } = await cached(`nws:hourly:${point.hourly_url}`, 15 * MIN, async () => {
    const j = await fetchJson(point.hourly_url, { source: 'nws-hourly' });
    return ((j.properties || {}).periods || []).map(x => ({
      time: x.startTime, temp: x.temperature, precip_chance: x.probabilityOfPrecipitation && x.probabilityOfPrecipitation.value,
      dewpoint_c: x.dewpoint && x.dewpoint.value, humidity: x.relativeHumidity && x.relativeHumidity.value,
      wind: x.windSpeed, wind_mph: windMph(x.windSpeed), wind_dir: x.windDirection, short: x.shortForecast, is_daytime: x.isDaytime,
    }));
  });
  return { periods: data.slice(0, hours), stale };
}

async function nwsObservation(point) {
  if (!point.stations_url) return null;
  const { data: stations } = await cached(`nws:stations:${point.stations_url}`, 24 * 60 * MIN, async () => {
    const j = await fetchJson(point.stations_url, { source: 'nws-stations' });
    return (j.features || []).slice(0, 4).map(f => ({ id: f.properties.stationIdentifier, name: f.properties.name, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
  });
  for (const st of stations) {
    try {
      const { data, stale } = await cached(`nws:obs:${st.id}`, 10 * MIN, async () => {
        const j = await fetchJson(`${NWS}/stations/${st.id}/observations/latest`, { source: 'nws-observations' });
        const p = j.properties || {};
        const v = k => (p[k] && p[k].value != null) ? p[k].value : null;
        return {
          station: st.id, station_name: st.name, time: p.timestamp || null, text: p.textDescription || null, icon: p.icon || null,
          temp_c: v('temperature'), dewpoint_c: v('dewpoint'), humidity: v('relativeHumidity'),
          wind_dir: v('windDirection'), wind_kmh: v('windSpeed'), gust_kmh: v('windGust'),
          pressure_pa: v('barometricPressure'), sea_level_pa: v('seaLevelPressure'), visibility_m: v('visibility'),
          wind_chill_c: v('windChill'), heat_index_c: v('heatIndex'), precip_last_hour_m: v('precipitationLastHour'),
          cloud_layers: (p.cloudLayers || []).map(c => ({ amount: c.amount, base_m: c.base && c.base.value })),
        };
      });
      if (data.temp_c != null || data.text) return { ...data, stale };
    } catch { /* try the next station */ }
  }
  return null;
}

// ─── Open-Meteo ──────────────────────────────────────────────────────
const OM_HOURLY = 'temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,precipitation_probability,precipitation,rain,showers,snowfall,weather_code,cloud_cover,visibility,wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index,pressure_msl,is_day,cape';
const OM_DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,daylight_duration,uv_index_max,precipitation_sum,rain_sum,snowfall_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant';
const OM_CURRENT = 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m';

async function openMeteo(lat, lon, { days = 7 } = {}) {
  const key = `om:${lat.toFixed(3)},${lon.toFixed(3)}:${days}`;
  const { data, stale } = await cached(key, 15 * MIN, async () => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=${OM_CURRENT}&hourly=${OM_HOURLY}&daily=${OM_DAILY}&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=${days}&past_hours=6`;
    const j = await fetchJson(url, { source: 'open-meteo' });
    const H = j.hourly || {}, D = j.daily || {}, C = j.current || {};
    const hours = (H.time || []).map((t, i) => ({
      time: t, temp_f: H.temperature_2m[i], feels_f: H.apparent_temperature[i], humidity: H.relative_humidity_2m[i], dewpoint_f: H.dew_point_2m[i],
      precip_chance: H.precipitation_probability[i], precip_in: H.precipitation[i], rain_in: H.rain[i], showers_in: H.showers[i], snow_in: H.snowfall[i],
      weather: wmo(H.weather_code[i]), cloud: H.cloud_cover[i], visibility_m: H.visibility[i], wind_mph: H.wind_speed_10m[i], gust_mph: H.wind_gusts_10m[i],
      wind_dir: H.wind_direction_10m[i], uv: H.uv_index[i], pressure_hpa: H.pressure_msl[i], is_day: H.is_day[i] === 1, cape: H.cape[i],
    }));
    const daysOut = (D.time || []).map((t, i) => ({
      date: t, weather: wmo(D.weather_code[i]), high_f: D.temperature_2m_max[i], low_f: D.temperature_2m_min[i],
      feels_high_f: D.apparent_temperature_max[i], feels_low_f: D.apparent_temperature_min[i], sunrise: D.sunrise[i], sunset: D.sunset[i],
      daylight_h: D.daylight_duration[i] != null ? Math.round(D.daylight_duration[i] / 360) / 10 : null, uv_max: D.uv_index_max[i],
      precip_in: D.precipitation_sum[i], rain_in: D.rain_sum[i], snow_in: D.snowfall_sum[i], precip_chance: D.precipitation_probability_max[i],
      wind_max_mph: D.wind_speed_10m_max[i], gust_max_mph: D.wind_gusts_10m_max[i], wind_dir: D.wind_direction_10m_dominant[i],
    }));
    return {
      timezone: j.timezone, elevation_m: j.elevation,
      current: {
        time: C.time, temp_f: C.temperature_2m, feels_f: C.apparent_temperature, humidity: C.relative_humidity_2m, is_day: C.is_day === 1,
        precip_in: C.precipitation, snow_in: C.snowfall, weather: wmo(C.weather_code), cloud: C.cloud_cover, pressure_hpa: C.pressure_msl,
        wind_mph: C.wind_speed_10m, gust_mph: C.wind_gusts_10m, wind_dir: C.wind_direction_10m, wind_compass: geo.compass(C.wind_direction_10m),
      },
      hourly: hours, daily: daysOut,
    };
  });
  return { ...data, stale };
}

const AQI_BANDS = [[50, 'Good', '#00E400'], [100, 'Moderate', '#FFFF00'], [150, 'Unhealthy for sensitive groups', '#FF7E00'], [200, 'Unhealthy', '#FF0000'], [300, 'Very unhealthy', '#8F3F97'], [Infinity, 'Hazardous', '#7E0023']];
const aqiBand = v => { if (v == null) return null; const b = AQI_BANDS.find(x => v <= x[0]); return { label: b[1], color: b[2] }; };

async function airQuality(lat, lon) {
  const key = `aq:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const { data, stale } = await cached(key, 30 * MIN, async () => {
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,dust,uv_index&hourly=us_aqi,pm2_5,ozone&forecast_days=2&timezone=auto`;
    const j = await fetchJson(url, { source: 'open-meteo-air' });
    const C = j.current || {}, H = j.hourly || {};
    return {
      current: { time: C.time, aqi: C.us_aqi, band: aqiBand(C.us_aqi), pm2_5: C.pm2_5, pm10: C.pm10, o3: C.ozone, no2: C.nitrogen_dioxide, so2: C.sulphur_dioxide, co: C.carbon_monoxide, dust: C.dust, uv: C.uv_index },
      hourly: (H.time || []).map((t, i) => ({ time: t, aqi: H.us_aqi[i], pm2_5: H.pm2_5[i], o3: H.ozone[i] })),
    };
  });
  return { ...data, stale };
}

// ─── The merged answer ───────────────────────────────────────────────
// conditions(lat, lon) → everything a FORECAST page needs. Each source
// fails independently: a point outside the US just has no `nws` block.
async function conditions(lat, lon, { hours = 48, days = 7 } = {}) {
  const [om, aq] = await Promise.allSettled([openMeteo(lat, lon, { days }), airQuality(lat, lon)]);
  let nws = null;
  try {
    const point = await nwsPoint(lat, lon);
    const [fc, hr, ob] = await Promise.allSettled([nwsForecast(point), nwsHourly(point, hours), nwsObservation(point)]);
    nws = {
      point,
      forecast: fc.status === 'fulfilled' ? fc.value : null,
      hourly: hr.status === 'fulfilled' ? hr.value : null,
      observation: ob.status === 'fulfilled' ? ob.value : null,
      errors: [fc, hr, ob].filter(r => r.status === 'rejected').map(r => r.reason.message),
    };
  } catch (e) {
    nws = { point: null, error: e.message };   // outside NWS coverage (or NWS down)
  }
  return {
    lat, lon,
    open_meteo: om.status === 'fulfilled' ? { ...om.value, hourly: om.value.hourly.slice(0, hours + 6) } : { error: om.reason.message },
    air_quality: aq.status === 'fulfilled' ? aq.value : { error: aq.reason.message },
    nws,
  };
}

module.exports = { conditions, nwsPoint, nwsForecast, nwsHourly, nwsObservation, openMeteo, airQuality, wmo, aqiBand, WMO };
