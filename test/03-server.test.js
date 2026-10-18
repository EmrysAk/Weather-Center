const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Live smoke: boot the real server on a spare port with polling off, hit the
// public surface, the auth gate, and every route's shape. Network-backed
// routes may answer 200 (source reachable) or 502 (not) — both are correct
// behavior for this test; what must never happen is a 500 or a hang.
module.exports = async ({ assert, TMP }) => {
  const PORT = 3996;
  const BASE = `http://127.0.0.1:${PORT}`;
  const TOKEN = 'weather-test-token';
  const HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');
  const authed = { Authorization: `Bearer ${TOKEN}` };
  const get = async (p, headers = {}, init = {}) => {
    const r = await fetch(BASE + p, { headers, ...init });
    let body = null; try { body = await r.clone().json(); } catch { body = await r.text(); }
    return { status: r.status, body };
  };

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), POLL_DISABLED: '1', AUTH_TOKEN_HASHES: HASH, NEWSROOM_URL: '', NEWSROOM_TOKEN: '' },
    stdio: 'inherit',
  });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { try { up = (await get('/health')).status === 200; } catch { /* booting */ } if (!up) await new Promise(r => setTimeout(r, 250)); }
  if (!up) { console.error('server never became healthy'); proc.kill(); process.exit(1); }

  try {
    assert((await get('/health')).body.ok === true, 'health is public');
    const page = await fetch(BASE + '/'); const html = await page.text();
    assert(page.status === 200 && /Weather Center/.test(html) && /app\.js/.test(html), 'the console page is public and loads its app');
    assert((await fetch(BASE + '/app.js')).status === 200 && (await fetch(BASE + '/style.css')).status === 200, 'static assets serve');
    assert((await get('/api/status')).status === 401, 'API requires auth');
    assert((await get('/api/status', { Authorization: 'Bearer nope' })).status === 401, 'bad token rejected');
    for (const p of ['/%2e%2e/package.json', '/..%2fpackage.json', '/public/../package.json']) {
      const r = await fetch(BASE + p); const body = await r.text();
      assert(r.status !== 200 && !/weather-center/.test(body), `no directory traversal through the static server (${p} → ${r.status})`);
    }

    const st = await get('/api/status', authed);
    assert(st.status === 200 && st.body.service === 'weather-center' && st.body.newsroom.configured === false && Array.isArray(st.body.sources), 'status reports service, newsroom config, source health');
    const w = await get('/api/watch', authed);
    assert(w.status === 200 && w.body.locations.length >= 5, 'watch list ships with defaults');
    assert((await get('/api/watch', authed, { method: 'POST', body: '{}' })).status === 400, 'POST /api/watch without q → 400');
    assert((await get('/api/watch?id=nope', authed, { method: 'DELETE' })).status === 404, 'DELETE an unknown watch id → 404');
    assert((await get('/api/conditions', authed)).status === 400, '/api/conditions without a location → 400');
    assert((await get('/api/conditions?lat=95&lon=0', authed)).status === 400, 'out-of-range lat → 400');
    assert((await get('/api/geocode', authed)).status === 400, '/api/geocode without q → 400');
    const news = await get('/api/news', authed);
    assert(news.status === 200 && news.body.configured === false && Array.isArray(news.body.rows), '/api/news answers from the (empty) mirror when the newsroom is not configured');
    assert((await get('/api/events', authed)).body.events.length === 0, '/api/events is empty without a newsroom');
    assert((await get('/api/nope', authed)).status === 404, 'unknown API route → 404');
    assert((await get('/api/status', authed, { method: 'POST' })).status === 405, 'wrong method → 405');

    // Network-backed routes: 200 or 502, never 500, and JSON either way.
    for (const p of ['/api/alerts/summary', '/api/alerts?state=OK&limit=5', '/api/alerts/geojson?event=tornado', '/api/tropical', '/api/spc/outlook?day=1', '/api/spc/reports', '/api/quakes?feed=all_hour', '/api/radar', '/api/space', '/api/drought', '/api/metar?ids=KOKC', '/api/conditions?lat=35.47&lon=-97.52&hours=12&days=3']) {
      const r = await get(p, authed);
      assert([200, 502].includes(r.status) && typeof r.body === 'object', `${p} → ${r.status} (JSON)`);
    }
    const br = await get('/briefing.txt?lat=35.47&lon=-97.52&label=Oklahoma%20City', authed);
    assert([200, 502].includes(br.status) && (br.status !== 200 || /WEATHER BRIEFING — Oklahoma City/.test(br.body)), `briefing.txt → ${br.status}`);
  } finally {
    proc.kill();
    await new Promise(r => { proc.on('exit', r); setTimeout(r, 4000).unref(); });
  }
};
