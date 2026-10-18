# Weather Center

The newsroom's weather desk as a live operations console, and the briefing service the Newsroom Reporters write from. Port **3006** in the service table (3001 Brief SE · 3002 Sports Center · 3003 Newsroom · 3004 Prediction Lab · 3005 Military Center · 3006 Weather Center).

It does **not** collect weather news itself. The [Newsroom Search Engine](https://github.com/General-IT-Services/AI-NEWS-SEARCH-ENGINE) (:3003) already polls the feeds, dedups, scores credibility and detects trends; this service pulls that desk through the newsroom's cursor API into a local mirror. What it adds is the weather itself, straight from the primary sources — every one of them keyless.

Zero runtime dependencies — plain Node 18+ — one pm2 process, one `data/` directory.

## What is in it

| View | What you get | Sources |
|---|---|---|
| **NOW** | Tornado / severe / flash-flood / total alert counters (life-threatening ones pulse), life-threatening list, embedded animated radar with alert polygons and tropical systems, a board of watched locations with conditions and alerts, alert families, busiest states, what is trending on the weather desk | NWS · RainViewer · NHC · SPC · SWPC · newsroom |
| **MAP** | Full-screen map: animated radar (2h history + nowcast, 4 palettes, opacity), satellite IR, NWS alert polygons in official colors (filter by family; tornado warnings pulse), SPC day 1–3 outlooks, today's storm reports, tropical systems, earthquakes, rivers in flood, wildfire incidents, watched locations; five basemaps; click anywhere for a point forecast or briefing | NWS · RainViewer · SPC · NHC · USGS · NWPS · InciWeb |
| **ALERTS** | Every active alert, filterable by state, event, severity and text; drawer with the full product text, VTEC, radar-indicated/observed tornado flag, hail and wind tags, expiry countdown, copy-for-article | NWS |
| **FORECAST** | Any place, ZIP or lat,lon: current conditions (nearest NWS station, model fallback worldwide), 48-hour chart (temperature, feels-like, precipitation chance, gusts, night shading), 7-day cards, the NWS narrative periods, alerts in effect at the point, SPC risk at the point, air quality (US AQI + pollutants), UV, sun, CAPE, nearby airport METARs with flight categories, tides at the nearest station; °F/°C toggle | NWS · Open-Meteo · SPC · AviationWeather · CO-OPS |
| **SEVERE** | SPC day 1–3 categorical risk, day-1 outlook map, today's tornado / hail / wind reports (table + map), mesoscale discussions, watches | SPC |
| **TROPICAL** | Every active system: category, winds, pressure, movement, advisory / discussion / cone / wind-probability links; basin outlooks | NHC |
| **QUAKES** | USGS feeds (hour, day, week, significant), largest, tsunami flags, felt reports, map | USGS |
| **WATER · FIRE** | Rivers at or above flood stage with forecast category, map, InciWeb wildfire incidents (acres, containment), optional NASA FIRMS hotspots, US Drought Monitor week-over-week | NWPS · InciWeb · FIRMS · USDM |
| **SPACE** | Planetary Kp history, NOAA G/S/R scales, solar wind, SWPC alerts, 3-day forecast | SWPC |
| **NEWS** | The weather desk, mirrored: stream with source, classes, primary-source and credibility badges; the desk's trend events; search; pull-now | newsroom |
| **BRIEFING** | One place → the reporter's block: alerts in effect, now, next 24h, NWS periods, 7-day, SPC risk, air quality, tropical systems within 1,200 km, rivers in flood within 150 km, quakes within 300 km, tides, newsroom coverage and trends. JSON and plain text | everything above |
| **STATUS** | Service, newsroom link and mirror cursor, per-source health (calls, errors, latency), cache, watched locations, theme/units/token | — |

The header ticker runs the national picture continuously; tab badges carry alert counts and go red when a tornado warning or flash flood emergency is in effect.

## Run it

```bash
cp .env.example .env            # set NEWSROOM_URL + NEWSROOM_TOKEN (minted on the newsroom box)
node scripts/make-token.js "james"   # mint a console token
npm start                       # :3006
npm test                        # offline units + newsroom client + live smoke
pm2 start ecosystem.config.js   # on the VPS
```

Open `http://<host>:3006/`, paste the token, and the console connects. Everything except `/health` and the page itself requires `Authorization: Bearer <token>`.

## API (● = token)

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness |
| ● `GET /api/status` | service, newsroom + mirror, per-source health, cache |
| ● `GET /api/alerts?state&event&severity&urgency&q&lat&lon&limit` · `/api/alerts/summary` · `/api/alerts/geojson?state&event` · `/api/alerts/one?id` | NWS active alerts |
| ● `GET /api/point-alerts?q\|lat,lon` | alerts in effect at a point (polygon + zone/county based) |
| ● `GET /api/geocode?q` · `/api/conditions?q\|lat,lon&hours&days` · `/api/airquality` | places, merged NWS + Open-Meteo conditions, AQI |
| ● `GET /api/tropical` · `/api/tropical/outlook` | NHC active systems, basin products |
| ● `GET /api/spc/outlook?day` · `/api/spc/risk?q\|lat,lon&day` · `/api/spc/reports?which` · `/api/spc/discussions` | SPC outlooks (GeoJSON), risk at a point, storm reports, MDs + watches |
| ● `GET /api/quakes?feed&min&limit` · `/api/quakes/near?q\|lat,lon&km` | USGS |
| ● `GET /api/radar` | RainViewer frame list + tile templates, NWS loop URLs |
| ● `GET /api/rivers?min&state&lat&lon&km` · `/api/fires` · `/api/drought` | NWPS gauges in flood, InciWeb (+FIRMS), USDM |
| ● `GET /api/metar?ids` · `/api/taf?ids` · `/api/metar/near?q\|lat,lon` | aviation |
| ● `GET /api/space` · `/api/tides?q\|lat,lon` | SWPC, CO-OPS |
| ● `GET /api/news?q&class&since&limit&order` · `/api/events` · `POST /api/newsroom/poll` | the mirrored weather desk and its trend events |
| ● `GET /api/briefing?q\|lat,lon` · `GET /briefing.txt?…` | the reporter's briefing (JSON with `text`, or plain text) |
| ● `GET/POST/DELETE /api/watch` · `GET /api/watch/board` | watched locations and their live board |

Every source answer carries `fetched_at` and `stale`: when a provider is down the last good answer keeps serving, flagged, instead of blanking a panel. `/api/status` shows per-source calls, errors and latency so a dead feed is visible before anyone asks.

## Feeding the Newsroom Reporters

`GET /briefing.txt?q=Moore,%20OK` (or `lat=&lon=`) returns the plain-text block; `GET /api/briefing` returns the same as structured JSON with the text inside. Mint the Reporters their own token so it can be revoked without touching anyone else's.

## Layout

```
server.js                 entry: configuration → services → routes → schedules
src/
  paths.js · env.js · auth.js · http.js · fetch.js · geo.js · store.js · rss.js · newsroom.js
  weather/
    geocode.js   alerts.js   forecast.js   tropical.js   spc.js   quakes.js
    radar.js     hazards.js  aviation.js   space.js      tides.js briefing.js
public/   index.html · app.js · style.css · favicon.svg
test/     run.js · 01-units · 02-newsroom · 03-server
scripts/  make-token.js
data/     watch.json · mirror/ · tokens.json   (gitignored)
docs/     LAUNCH.md
```
