const path = require('path');

module.exports = async ({ assert, TMP }) => {
  const { setFetch, clearCache } = require('../src/fetch');
  const { Mirror } = require('../src/store');
  const { Newsroom } = require('../src/newsroom');

  const row = i => ({ id: `n${i}`, headline: `Hurricane update ${i}`, desk: 'weather', source: 'nws-alerts-atom', ingested_at: new Date(1700000000000 + i * 1000).toISOString() });
  const calls = [];
  // Two full pages then a short one: the client must page forward from the
  // cursor until a short page, and pass the newsroom token.
  setFetch(async (url, opts) => {
    calls.push({ url: String(url), auth: opts.headers.Authorization });
    const u = new URL(url);
    if (u.pathname === '/news') {
      const since = u.searchParams.get('since');
      const start = since ? Math.floor((Date.parse(since) - 1700000000000) / 1000) : 0;   // inclusive boundary repeats by design
      const rows = []; for (let i = start; i < Math.min(start + 200, 450); i++) rows.push(row(i));
      return { ok: true, status: 200, text: async () => JSON.stringify({ rows }) };
    }
    if (u.pathname === '/events') return { ok: true, status: 200, text: async () => JSON.stringify({ events: [{ id: 'weather:melissa-2026-10-18', desk: 'weather', label: 'Hurricane Melissa', count: 9, z: 4.1 }] }) };
    if (u.pathname === '/health') return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, tickers: 10082 }) };
    return { ok: false, status: 404, text: async () => '' };
  });
  clearCache();

  const off = new Newsroom({ desk: 'weather', mirror: new Mirror(path.join(TMP, 'm0'), 'weather') });
  assert(off.enabled === false && (await off.poll()) === 0 && (await off.health()).configured === false, 'unconfigured newsroom client is inert');

  const mirror = new Mirror(path.join(TMP, 'm1'), 'weather');
  const nr = new Newsroom({ url: 'http://newsroom.test:3003/', token: 'tok', desk: 'weather', mirror, log: { warn() {} } });
  const added = await nr.poll();
  assert(added === 450 && mirror.size === 450, 'poll pages forward until a short page and mirrors every row once');
  assert(calls.every(c => c.auth === 'Bearer tok'), 'every newsroom call carries the bearer token');
  assert(calls[0].url.includes('desk=weather') && calls[0].url.includes('order=asc') && !calls[0].url.includes('since='), 'first poll starts without a cursor');
  assert(calls[1].url.includes(`since=${encodeURIComponent(row(199).ingested_at)}`), 'second page resumes from the newest ingested_at');
  assert(mirror.meta.polls === 1 && mirror.meta.pulled === 450 && mirror.meta.last_error === null, 'poll meta is recorded');
  const before = calls.length;
  const again = await nr.poll();
  assert(again === 0 && calls.length === before + 1, 'a quiet poll is one request, boundary row deduped');

  const evs = await nr.events();
  assert(evs.length === 1 && evs[0].label === 'Hurricane Melissa', 'events() returns the desk\'s trend events');
  const h = await nr.health();
  assert(h.configured && h.ok && h.tickers === 10082, 'health() relays the newsroom detail');

  setFetch(async () => { throw new Error('ECONNREFUSED'); });
  await nr.poll();
  assert(/ECONNREFUSED/.test(mirror.meta.last_error) && mirror.size === 450, 'a failed poll records the error and keeps the mirror');

  setFetch(null); clearCache();
};
