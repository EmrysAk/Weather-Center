// .env loader — zero dependencies, like everything else here.
//
// Loads KEY=VALUE pairs into process.env at boot so API keys live in a
// file (gitignored) instead of the pm2 start command. The real
// environment always wins: a variable already set is never overridden,
// so `PORT=3006 node server.js` still behaves as expected.
//
// Default file is .env at the repository root (next to server.js). ENV_FILE points anywhere
// else — e.g. a shared env file another service already maintains.
//
// Format: KEY=value, one per line. `export ` prefixes, blank lines and
// #-comment lines are tolerated; values may be single- or double-quoted
// (quotes stripped); an unquoted value drops any trailing ` # comment`.

const fs = require('fs');
const path = require('path');

function loadEnv(file = process.env.ENV_FILE || path.join(require('./paths').ROOT, '.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const loaded = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (m[1] in process.env) continue;   // the real environment wins
    process.env[m[1]] = value;
    loaded.push(m[1]);
  }
  return loaded;   // names only — values never leave this function
}

module.exports = { loadEnv };
