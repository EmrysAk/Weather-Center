// Mint an access token for one person. Run ON THE SERVER:
//
//   node scripts/make-token.js "james"
//
// Prints the token ONCE (hand it to the person over a secure channel) and
// appends only its SHA-256 hash to data/tokens.json. To revoke someone,
// delete their row from tokens.json and restart.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const name = process.argv[2];
if (!name) {
  console.error('usage: node scripts/make-token.js <person-name>');
  process.exit(1);
}

const token = crypto.randomBytes(32).toString('hex');
const hash = crypto.createHash('sha256').update(token).digest('hex');

const file = path.join(require('../src/paths').DATA_DIR, 'tokens.json');
let rows = [];
try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first token */ }
rows.push({ name, hash, created: new Date().toISOString() });
// Owner-only perms — the file holds only hashes, but there's no reason for it
// to be group/world-readable.
fs.writeFileSync(file, JSON.stringify(rows, null, 2) + '\n', { mode: 0o600 });

console.log(`token for "${name}" (shown once, store it safely):\n`);
console.log(`  ${token}\n`);
console.log(`hash appended to data/tokens.json — restart the server to load it.`);
