// Syntax gate for the backend (LEO-001).
//
// Runs `node --check` over every .js file in backend/ (excluding node_modules
// and the mongodb-memory-server cache). This alone cannot catch a require() of
// a nonexistent module — that gap is covered by `yarn test`, which requires the
// real chat router and its model graph.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.cache']);

function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = collect(backendRoot, []);
let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`SYNTAX ERROR: ${path.relative(backendRoot, file)}`);
    console.error(String(err.stderr));
  }
}

console.log(`verify: checked ${files.length} files, ${failed} failed`);
process.exit(failed ? 1 : 0);
