#!/usr/bin/env node
/**
 * build-state.js — regenerates ops/leo-nightly/state.json from FEATURES.md.
 *
 * state.json is the ONLY machine-readable queue state; FEATURES.md checkboxes are for
 * humans. Generating one from the other means a hand-edit to the queue cannot silently
 * desynchronise them. Run after editing FEATURES.md:
 *
 *   node ops/leo-nightly/build-state.js          # write
 *   node ops/leo-nightly/build-state.js --check  # verify in sync, exit 1 if not
 *
 * Existing status/attempts/history are PRESERVED — this only adds new items and updates
 * dependency metadata. It never resets an item the routine has already worked.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const FEATURES = path.join(ROOT, 'FEATURES.md');
const STATE = path.join(__dirname, 'state.json');

// Items that belong to a shared cluster branch rather than their own.
const CLUSTERS = { 'LEO-027': 'scrape-pipeline', 'LEO-028': 'scrape-pipeline', 'LEO-029': 'scrape-pipeline' };

// Blanket gates that apply to a whole block, which the per-item "(needs X)" markers omit.
const BLOCK_GATES = { E: ['LEO-001'] };

function parse() {
  const md = fs.readFileSync(FEATURES, 'utf8');
  const lines = md.split('\n');
  const items = {};
  let block = null;
  let inCompleted = false;

  for (const line of lines) {
    const blockMatch = line.match(/^## Block ([A-Z]) —/);
    if (blockMatch) { block = blockMatch[1]; inCompleted = false; }
    if (/^## Cluster:/.test(line)) { block = 'CLUSTER'; inCompleted = false; }
    if (/^## Completed Items/.test(line)) inCompleted = true;
    if (/^## Blocked Items/.test(line)) inCompleted = false;
    if (inCompleted) continue;

    // Ticked lines parse too. Matching only "- [ ]" meant that ticking a box in place
    // silently dropped the item from state.json, taking every dependsOn reference to it
    // down as well.
    const m = line.match(/^- \[[ xX]\] \*\*\((LEO-\d+)\)/);
    if (!m) continue;
    const id = m[1];

    const dependsOn = new Set(BLOCK_GATES[block] || []);
    const needs = line.match(/\(needs ([^)]+)\)/);
    if (needs) needs[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((d) => dependsOn.add(d));
    dependsOn.delete(id);

    items[id] = {
      // order: position of this item's checkbox in FEATURES.md, counting from 1.
      // PRIORITY IS FILE POSITION; the LEO-nnn id is permanent identity and is never
      // renumbered — ledger events join on it, so renumbering would silently rewrite
      // history. To reprioritize an item, move its whole block in FEATURES.md and
      // regenerate. Refreshed on every regen, never carried forward.
      order: Object.keys(items).length + 1,
      status: 'pending',
      attempts: 0,
      cluster: CLUSTERS[id] || null,
      branch: null,
      dependsOn: [...dependsOn].sort(),
      claimedAtUtc: null,
      runId: null,
      lastFail: null,
    };
  }
  return items;
}

const fresh = parse();
const prior = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { items: {} };

// Preserve everything the routine owns; refresh only what FEATURES.md owns.
for (const [id, item] of Object.entries(fresh)) {
  const was = prior.items?.[id];
  if (was) {
    item.status = was.status;
    item.attempts = was.attempts;
    item.branch = was.branch;
    item.claimedAtUtc = was.claimedAtUtc;
    item.runId = was.runId;
    item.lastFail = was.lastFail;
  }
}

// Carry forward items FEATURES.md no longer lists but the routine has already worked —
// chiefly ones moved into "## Completed Items", which parse() skips by design. Without this,
// finishing an item and filing it away deletes its state, and LEO-005/LEO-023/LEO-025/LEO-030
// stop resolving the dependsOn entries that gate them.
//
// Deliberately narrower than "carry forward everything": an item still at pending/0 attempts
// has no history worth keeping, so deleting one from FEATURES.md really does retire it.
for (const [id, was] of Object.entries(prior.items || {})) {
  if (fresh[id]) continue;
  if (was.status === 'pending' && was.attempts === 0) continue;
  // No file position — carried items are done/blocked history, never selectable, so they
  // hold no place in the priority order.
  fresh[id] = { ...was, order: null };
}

const next = { version: 1, items: fresh, openCluster: prior.openCluster ?? null };
const serialized = JSON.stringify(next, null, 2) + '\n';

if (process.argv.includes('--check')) {
  // Normalise line endings before comparing. `* text=auto` in .gitattributes means a fresh
  // Windows checkout has CRLF while this script writes LF, so a raw byte comparison reports
  // "out of sync" on a tree that is perfectly in sync.
  const norm = (s) => s.replace(/\r\n/g, '\n');
  const current = fs.existsSync(STATE) ? norm(fs.readFileSync(STATE, 'utf8')) : '';
  if (current !== norm(serialized)) {
    console.error('✗ state.json is out of sync with FEATURES.md — run: node ops/leo-nightly/build-state.js');
    process.exit(1);
  }
  console.log(`✓ state.json in sync (${Object.keys(fresh).length} items)`);
  process.exit(0);
}

fs.writeFileSync(STATE, serialized);
const withDeps = Object.entries(fresh).filter(([, v]) => v.dependsOn.length);
console.log(`wrote ${Object.keys(fresh).length} items to state.json`);
console.log(`  clustered: ${Object.entries(fresh).filter(([, v]) => v.cluster).map(([k]) => k).join(', ') || 'none'}`);
console.log(`  with dependencies: ${withDeps.length}`);
for (const [id, v] of withDeps) console.log(`    ${id} ← ${v.dependsOn.join(', ')}`);
const nextUp = Object.entries(fresh)
  .filter(([, v]) => v.status === 'pending' && v.order != null)
  .sort((a, b) => a[1].order - b[1].order)
  .slice(0, 5)
  .map(([id, v]) => `#${v.order} ${id}`);
console.log(`  next up (by file order): ${nextUp.join('  ·  ') || '(none pending)'}`);
