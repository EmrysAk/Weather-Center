# Launch checklist — Weather Center

## Ports

| Port | Service |
|---|---|
| 3001 | Brief Search Engine (BSE) |
| 3002 | Sports Center |
| 3003 | Newsroom Search Engine — the collector every desk service reads |
| 3004 | Prediction Lab |
| 3005 | Military Center |
| **3006** | **Weather Center (this repo)** |
| 3007… | next services (the Newsroom Reporters) |

## 1. Put it on the box

```bash
git clone <this repo> && cd Weather-Center
node -v        # >= 18
```

No `npm install` — zero runtime dependencies.

## 2. Mint a token on the newsroom, then configure

On the **newsroom** box (`AI-NEWS-SEARCH-ENGINE`):

```bash
node scripts/make-token.js "weather-center"     # copy the token it prints
```

Here:

```bash
cp .env.example .env
# NEWSROOM_URL=http://127.0.0.1:3003   (or the newsroom's host)
# NEWSROOM_TOKEN=<the token above>
# CENTER_USER_AGENT=Weather Center <your contact email>
```

Without the newsroom the console still runs — every weather panel works, the NEWS and trend panels say "newsroom not configured".

## 3. Mint console tokens (one per person, plus one for the Reporters)

```bash
node scripts/make-token.js "james"
node scripts/make-token.js "newsroom-reporters"
```

## 4. Run under pm2

```bash
pm2 start ecosystem.config.js && pm2 save
pm2 logs weather-center
curl http://127.0.0.1:3006/health      # {"ok":true,"service":"weather-center"}
```

## 5. nginx (recommended)

Proxy `/weather/` (or a host) → `127.0.0.1:3006`, `TRUST_PROXY=1`. The page loads Leaflet from unpkg and map tiles from Esri / OpenStreetMap / RainViewer directly in the browser, so those hosts must be reachable from the operator's browser, not from the server.

## Verify

| Check | Expect |
|---|---|
| `GET /health` | `{"ok":true}` |
| `GET /api/status` (token) | `newsroom.health.ok: true`, sources with `ok > 0` after a minute |
| NOW view | counters populated, ticker scrolling, radar animating in the minimap |
| STATUS → Data sources | `nws-alerts`, `rainviewer`, `nhc-storms`, `spc-outlook` green |

## Operational notes

- **One process.** Caches and the newsroom mirror are per-process.
- **Backups:** `data/watch.json`, `data/mirror/`, `data/tokens.json`.
- **Provider etiquette:** NWS asks for an identifying User-Agent (set `CENTER_USER_AGENT`) and no more than one alerts pull a minute — this service pulls every 90 s and answers every question from memory. Everything else is cached between 2 and 60 minutes per source and serves stale data, flagged, when a provider is down.
- **Optional key:** `FIRMS_MAP_KEY` (NASA, free) adds satellite fire hotspots to the map and WATER · FIRE view.
