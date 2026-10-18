// HTTP helpers: JSON / HTML / static replies, CORS, a size-capped body
// reader, query-param parsing, and a tiny static file server for public/.

const fs = require('fs');
const path = require('path');

const { PUBLIC_DIR } = require('./paths');

function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

function html(res, body, extra = {}) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...extra });
  res.end(body);
}

function text(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...extra });
  res.end(body);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

// Serve a file from public/ (no directory traversal — the path is resolved
// and must stay inside PUBLIC_DIR). Returns true if it answered.
function serveStatic(res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath); } catch { return false; }
  if (rel.includes('\0')) return false;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) return false;
  let body;
  try { body = fs.readFileSync(file); } catch { return false; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
  return true;
}

function makeCors(origins) {
  const list = (origins || []).filter(Boolean);
  if (list.length === 0) return () => ({});
  const wildcard = list.includes('*');
  return req => {
    const origin = req.headers.origin || '';
    const allowed = wildcard ? '*' : list.includes(origin) ? origin : list[0];
    const headers = {
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (!wildcard) headers['Vary'] = 'Origin';
    return headers;
  };
}

function readJsonBody(req, capBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > capBytes) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function intParam(url, name, def, min, max) {
  const n = parseInt(url.searchParams.get(name) || String(def), 10);
  const v = Number.isFinite(n) ? n : def;
  return Math.min(max, Math.max(min, v));
}

function floatParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === '') return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function strParam(url, name, max = 120) {
  const v = url.searchParams.get(name);
  return v ? String(v).trim().slice(0, max) : '';
}

module.exports = { json, html, text, serveStatic, makeCors, readJsonBody, intParam, floatParam, strParam };
