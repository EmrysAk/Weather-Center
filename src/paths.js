// The one module that knows where things live on disk. Every other module
// asks here instead of computing paths from its own __dirname, so moving a
// file never moves the data it reads.
//
//   ROOT        the repository / deployment directory (where server.js is)
//   DATA_DIR    dictionaries, seeds, denylist, tokens.json, and the store
//   PUBLIC_DIR  the page shells served by the HTTP layer

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

module.exports = { ROOT, DATA_DIR, PUBLIC_DIR };
