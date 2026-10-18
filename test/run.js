// Test runner: offline units with fixtures (no network — fetch is swapped
// for a stub), then a live-server smoke test with auth. `npm test`, or
// `node test/run.js <name>` for one section.

const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error(`FAIL — ${msg}`); }
  else console.log(`ok — ${msg}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-center-test-'));
const filter = process.argv[2] || '';
const files = fs.readdirSync(__dirname).filter(f => /^\d\d-.*\.test\.js$/.test(f) && f.includes(filter)).sort();

(async () => {
  for (const f of files) {
    console.log(`\n── ${f.replace(/^\d\d-|\.test\.js$/g, '')} ──`);
    await require(path.join(__dirname, f))({ assert, TMP });
  }
  console.log(failures === 0 ? '\nall tests passed' : `\n${failures} test(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
