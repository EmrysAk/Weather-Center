// Bearer-token auth. Private service: only the operator and their company
// hold tokens.
//
// Design (deliberately stricter than Brief's app token):
//   - Tokens are 32 random bytes (hex). 256 bits — not brute-forceable.
//   - The server never stores tokens, only SHA-256 hashes. Sources:
//       AUTH_TOKEN_HASHES  env — comma-separated sha256 hex digests
//       data/tokens.json   — [{ name, hash, created }] via scripts/make-token.js
//   - Comparison is constant-time (timingSafeEqual on the digest).
//   - Secure by default: with no hashes configured, every request is refused
//     (503) rather than falling open.
//   - Fail lockout: too many bad tokens from one IP → 429 for a cooldown.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DATA_DIR } = require('./paths');

const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

let hashes = [];

function loadHashes() {
  const fromEnv = (process.env.AUTH_TOKEN_HASHES || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(s => /^[0-9a-f]{64}$/.test(s));
  let fromFile = [];
  try {
    const rows = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    fromFile = rows.map(r => String(r.hash || '').toLowerCase()).filter(h => /^[0-9a-f]{64}$/.test(h));
  } catch { /* no tokens file — env may still provide hashes */ }
  hashes = [...new Set([...fromEnv, ...fromFile])].map(h => Buffer.from(h, 'hex'));
  return hashes.length;
}

// ─── Per-IP failure lockout ──────────────────────────────────────────
const fails = new Map();  // ip → { count, resetAt }

// TRUST_PROXY counts how many reverse proxies sit in front of us (usually 1).
// X-Forwarded-For is client-appended on the left and proxy-appended on the
// right, so the trustworthy client IP is the Nth-from-last entry — never the
// leftmost, which an attacker sets freely to spread failures across fake IPs
// and defeat the lockout.
function clientIp(req) {
  const hops = parseInt(process.env.TRUST_PROXY || '0', 10);
  if (hops > 0) {
    const chain = String(req.headers['x-forwarded-for'] || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const ip = chain[chain.length - hops];
    if (ip) return ip;
  }
  return req.socket.remoteAddress || 'unknown';
}

function locked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() > f.resetAt) { fails.delete(ip); return false; }
  return f.count >= MAX_FAILS;
}

function recordFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() > f.resetAt) {
    fails.set(ip, { count: 1, resetAt: Date.now() + FAIL_WINDOW_MS });
  } else {
    f.count++;
  }
  // Bound the map so a spoofed-IP flood can't grow memory forever. Drop
  // expired entries first; if still over cap, evict the oldest-expiring rather
  // than clear() — wiping every counter would hand an attacker a fresh slate.
  if (fails.size > 10000) {
    const now = Date.now();
    for (const [k, v] of fails) if (now > v.resetAt) fails.delete(k);
    if (fails.size > 10000) {
      const oldest = [...fails.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
      for (let i = 0; i < oldest.length && fails.size > 8000; i++) fails.delete(oldest[i][0]);
    }
  }
}

// ─── The check ───────────────────────────────────────────────────────
// Returns { ok: true } or { ok: false, status, error }.
function authenticate(req) {
  if (hashes.length === 0) {
    return { ok: false, status: 503, error: 'no tokens configured — run scripts/make-token.js on the server' };
  }
  const ip = clientIp(req);
  if (locked(ip)) {
    return { ok: false, status: 429, error: 'too many failed attempts — try later' };
  }
  const header = String(req.headers.authorization || '');
  const m = header.match(/^Bearer\s+(\S+)$/i);
  if (!m) {
    return { ok: false, status: 401, error: 'missing bearer token' };
  }
  const digest = crypto.createHash('sha256').update(m[1]).digest();
  for (const h of hashes) {
    if (h.length === digest.length && crypto.timingSafeEqual(h, digest)) {
      fails.delete(ip);
      return { ok: true };
    }
  }
  recordFail(ip);
  return { ok: false, status: 401, error: 'invalid token' };
}

module.exports = { authenticate, loadHashes };
