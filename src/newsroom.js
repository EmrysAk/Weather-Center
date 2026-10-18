// The newsroom client. A center does not collect its desk's news itself —
// the Newsroom Search Engine (port 3003) already polls every feed, dedups,
// scores credibility and detects trends. The center pulls one desk from it
// with the lossless cursor-paging contract the newsroom documents:
//
//   GET /news?desk=<desk>&order=asc&since=<cursor>&limit=200
//   Authorization: Bearer <token minted on the newsroom>
//
// Rows land in a local Mirror (store.js), so the center keeps serving when
// the newsroom is briefly unreachable. Trend events are fetched on demand
// and cached. With no NEWSROOM_URL configured the client is simply off and
// every news panel says so.

const { fetchJson, cached } = require('./fetch');

const PAGE = 200;

class Newsroom {
  constructor({ url, token, desk, mirror, log = console } = {}) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.token = token || '';
    this.desk = desk;
    this.mirror = mirror;
    this.log = log;
    this.enabled = Boolean(this.url && this.desk);
    this.polling = false;
  }

  headers() { return { Authorization: `Bearer ${this.token}` }; }

  async get(pathAndQuery, { source = 'newsroom', ttl = 0 } = {}) {
    if (!this.enabled) throw new Error('newsroom not configured (NEWSROOM_URL / NEWSROOM_TOKEN)');
    const run = () => fetchJson(`${this.url}${pathAndQuery}`, { headers: this.headers(), source, timeout: 15000 });
    if (!ttl) return run();
    return (await cached(`newsroom:${pathAndQuery}`, ttl, run)).data;
  }

  // One poll: walk forward from the cursor until a short page. Returns the
  // number of new rows mirrored.
  async poll() {
    if (!this.enabled || this.polling) return 0;
    this.polling = true;
    let added = 0;
    try {
      for (let page = 0; page < 20; page++) {
        const qs = new URLSearchParams({ desk: this.desk, order: 'asc', limit: String(PAGE) });
        if (this.mirror.meta.cursor) qs.set('since', this.mirror.meta.cursor);
        const data = await this.get(`/news?${qs}`);
        const rows = Array.isArray(data.rows) ? data.rows : [];
        added += this.mirror.upsert(rows);
        if (rows.length < PAGE) break;
      }
      this.mirror.saveMeta({ last_poll_at: new Date().toISOString(), last_error: null, polls: this.mirror.meta.polls + 1, pulled: this.mirror.meta.pulled + added });
    } catch (e) {
      this.mirror.saveMeta({ last_poll_at: new Date().toISOString(), last_error: e.message, polls: this.mirror.meta.polls + 1 });
      this.log.warn(`newsroom poll failed: ${e.message}`);
    } finally {
      this.polling = false;
    }
    return added;
  }

  start(intervalMs = 2 * 60 * 1000) {
    if (!this.enabled) return;
    setTimeout(() => this.poll(), 1500).unref();
    setInterval(() => this.poll(), intervalMs).unref();
  }

  // Trend events for this desk (newsroom-side z-score detector), cached 60s.
  async events(limit = 40) {
    const data = await this.get(`/events?desk=${encodeURIComponent(this.desk)}&limit=${limit}`, { ttl: 60 * 1000 });
    return Array.isArray(data.events) ? data.events : [];
  }

  // Liveness of the upstream, cached 30s; never throws.
  async health() {
    if (!this.enabled) return { configured: false };
    try {
      const data = await this.get('/health?detail=1', { ttl: 30 * 1000 });
      return { configured: true, ok: true, ...data };
    } catch (e) {
      return { configured: true, ok: false, error: e.message };
    }
  }

  status() {
    return { configured: this.enabled, url: this.url || null, desk: this.desk, mirror: this.mirror ? this.mirror.stats() : null };
  }
}

module.exports = { Newsroom };
