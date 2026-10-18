// Local persistence, two shapes:
//
//   JsonFile(path)       a small JSON document read at boot and rewritten
//                        atomically on every change (the watch list).
//   Mirror(dir, name)    a bounded, id-keyed JSONL mirror of rows pulled from
//                        the newsroom, so the center keeps serving its desk's
//                        stories when the newsroom is briefly unreachable.
//                        Append-only during operation; compacted on load.

const fs = require('fs');
const path = require('path');

class JsonFile {
  constructor(file, fallback) {
    this.file = file;
    this.fallback = fallback;
    this.value = this.load();
  }
  load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { return typeof this.fallback === 'function' ? this.fallback() : JSON.parse(JSON.stringify(this.fallback)); }
  }
  save(value) {
    this.value = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    return value;
  }
}

class Mirror {
  constructor(dir, name, { maxRows = 20000 } = {}) {
    this.dir = dir;
    this.file = path.join(dir, `${name}.jsonl`);
    this.metaFile = path.join(dir, `${name}.meta.json`);
    this.maxRows = maxRows;
    this.byId = new Map();     // id → row, insertion = ingestion order
    this.meta = { cursor: null, last_poll_at: null, last_error: null, polls: 0, pulled: 0 };
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); if (r && r.id) { this.byId.delete(r.id); this.byId.set(r.id, r); } } catch { /* skip */ }
      }
    } catch { /* none yet */ }
    try { this.meta = { ...this.meta, ...JSON.parse(fs.readFileSync(this.metaFile, 'utf8')) }; } catch { /* none yet */ }
    this.bound();
    this.compact();
  }

  get rows() { return [...this.byId.values()]; }
  get size() { return this.byId.size; }

  // Keep the newest maxRows by ingestion order.
  bound() {
    while (this.byId.size > this.maxRows) this.byId.delete(this.byId.keys().next().value);
  }

  compact() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, this.rows.map(r => JSON.stringify(r)).join('\n') + (this.byId.size ? '\n' : ''));
    fs.renameSync(tmp, this.file);
  }

  // Add rows (new ids only); returns how many were new. Cursor advances to
  // the newest ingested_at seen.
  upsert(rows) {
    let added = 0;
    const lines = [];
    for (const r of rows) {
      if (!r || !r.id || this.byId.has(r.id)) continue;
      this.byId.set(r.id, r);
      lines.push(JSON.stringify(r));
      added++;
      if (r.ingested_at && (!this.meta.cursor || r.ingested_at > this.meta.cursor)) this.meta.cursor = r.ingested_at;
    }
    if (lines.length) fs.appendFileSync(this.file, lines.join('\n') + '\n');
    this.bound();
    return added;
  }

  saveMeta(patch = {}) {
    this.meta = { ...this.meta, ...patch };
    fs.writeFileSync(this.metaFile, JSON.stringify(this.meta, null, 2) + '\n');
  }

  // Newest first by default. q matches headline/snippet (case-insensitive);
  // cls matches a class id; since filters ingested_at.
  query({ q, cls, since, limit = 50, order = 'desc', pred } = {}) {
    const needle = q ? String(q).toLowerCase() : null;
    const sinceMs = since ? Date.parse(since) : null;
    const rows = this.rows;
    const out = [];
    const n = rows.length;
    for (let k = 0; k < n && out.length < limit; k++) {
      const r = rows[order === 'asc' ? k : n - 1 - k];
      if (cls && !(r.classes || []).includes(cls)) continue;
      if (sinceMs && !(Date.parse(r.ingested_at) >= sinceMs)) continue;
      if (needle && !(`${r.headline} ${r.snippet || ''}`.toLowerCase().includes(needle))) continue;
      if (pred && !pred(r)) continue;
      out.push(r);
    }
    return out;
  }

  stats() {
    const rows = this.rows;
    const dayAgo = Date.now() - 86400 * 1000;
    return {
      rows: rows.length,
      rows_24h: rows.filter(r => Date.parse(r.ingested_at) >= dayAgo).length,
      newest: rows.length ? rows[rows.length - 1].ingested_at : null,
      oldest: rows.length ? rows[0].ingested_at : null,
      ...this.meta,
    };
  }
}

module.exports = { JsonFile, Mirror };
