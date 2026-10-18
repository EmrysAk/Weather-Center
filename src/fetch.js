// Outbound HTTP for every data source, with the three things a long-running
// service needs around it: an identifying User-Agent, per-source health
// stats (for the STATUS page), and a TTL cache that serves stale data while
// a source is down instead of blanking a panel.
//
// Zero dependencies — global fetch (Node 18+). `setFetch` swaps the
// implementation for tests.

const UA = process.env.CENTER_USER_AGENT || 'Weather Center (contact via CENTER_USER_AGENT env)';

let fetchImpl = (...args) => fetch(...args);
function setFetch(fn) { fetchImpl = fn || ((...args) => fetch(...args)); }

// ─── Per-source health ───────────────────────────────────────────────
const stats = new Map();   // source → { calls, ok, errors, last_ok_at, last_error, last_error_at, last_ms }
function stat(source) {
  let s = stats.get(source);
  if (!s) { s = { calls: 0, ok: 0, errors: 0, last_ok_at: null, last_error: null, last_error_at: null, last_ms: null }; stats.set(source, s); }
  return s;
}
function sourceStats() {
  return [...stats.entries()].map(([id, s]) => ({ id, ...s })).sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchText(url, { timeout = 12000, headers = {}, source = 'other', method = 'GET', body } = {}) {
  const s = stat(source);
  s.calls++;
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      method, body,
      headers: { 'User-Agent': UA, Accept: 'application/json, application/geo+json, text/xml, application/xml, text/plain, */*', ...headers },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    s.ok++; s.last_ok_at = new Date().toISOString(); s.last_ms = Date.now() - started;
    return text;
  } catch (e) {
    s.errors++; s.last_error = e.message; s.last_error_at = new Date().toISOString(); s.last_ms = Date.now() - started;
    throw e;
  }
}

async function fetchJson(url, opts) {
  const text = await fetchText(url, opts);
  try { return JSON.parse(text); }
  catch { throw new Error(`not JSON (${String(text).slice(0, 60).replace(/\s+/g, ' ')}…)`); }
}

// ─── TTL cache with stale-on-error ───────────────────────────────────
// cached(key, ttlMs, fn, { staleMs }) → { data, fetched_at, stale, error? }
// Fresh entry: returned as is. Expired: fn runs; on success the entry is
// replaced; on failure the old data is returned with stale: true and the
// error, as long as it is younger than staleMs (default 6× ttl). Concurrent
// callers share one in-flight fetch.
const cache = new Map();   // key → { data, fetched_at, ttl, promise }

async function cached(key, ttlMs, fn, { staleMs } = {}) {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && entry.data !== undefined && now - entry.at < ttlMs) {
    return { data: entry.data, fetched_at: new Date(entry.at).toISOString(), stale: false };
  }
  if (entry && entry.promise) return entry.promise;
  const promise = (async () => {
    try {
      const data = await fn();
      cache.set(key, { data, at: Date.now(), ttl: ttlMs });
      return { data, fetched_at: new Date().toISOString(), stale: false };
    } catch (e) {
      const maxStale = staleMs || ttlMs * 6;
      if (entry && entry.data !== undefined && Date.now() - entry.at < maxStale) {
        cache.set(key, { data: entry.data, at: entry.at, ttl: ttlMs });   // clear promise, keep data
        return { data: entry.data, fetched_at: new Date(entry.at).toISOString(), stale: true, error: e.message };
      }
      if (entry) cache.set(key, { data: entry.data, at: entry.at, ttl: ttlMs });
      throw e;
    }
  })();
  cache.set(key, { ...(entry || {}), promise });
  return promise;
}

function cacheStats() {
  const out = [];
  for (const [key, e] of cache) {
    if (e.data === undefined) continue;
    out.push({ key, age_s: Math.round((Date.now() - e.at) / 1000), ttl_s: Math.round(e.ttl / 1000) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function clearCache() { cache.clear(); }

module.exports = { UA, setFetch, fetchText, fetchJson, cached, sourceStats, cacheStats, clearCache };
