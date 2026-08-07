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

    const m = line.match(/^- \[ \] \*\*\((LEO-\d+)\)/);
    if (!m) continue;
    const id = m[1];

    const dependsOn = new Set(BLOCK_GATES[block] || []);
    const needs = line.match(/\(needs ([^)]+)\)/);
    if (needs) needs[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((d) => dependsOn.add(d));
    dependsOn.delete(id);

    items[id] = {
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

const next = { version: 1, items: fresh, openCluster: prior.openCluster ?? null };
const serialized = JSON.stringify(next, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : '';
  if (current !== serialized) {
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
