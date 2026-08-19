// Low-confidence hedging band (LEO-038).
//
// The band decision is pure (topScore, threshold, band width) — no DB, no
// model call. The hint injection itself lives in claude.js and rides on the
// model's behavior; only the decision is asserted here.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');

const { confidenceBand, DEFAULT_BAND } = require('../src/services/confidence');

test('below threshold: none — the no-context path owns it', () => {
  assert.equal(confidenceBand({ topScore: 0.7499, threshold: 0.75, band: 0.05 }), 'none');
  assert.equal(confidenceBand({ topScore: 0, threshold: 0.75, band: 0.05 }), 'none');
});

test('exactly at threshold: low', () => {
  assert.equal(confidenceBand({ topScore: 0.75, threshold: 0.75, band: 0.05 }), 'low');
});

test('inside the band: low', () => {
  assert.equal(confidenceBand({ topScore: 0.7799, threshold: 0.75, band: 0.05 }), 'low');
});

test('at threshold + band: high', () => {
  assert.equal(confidenceBand({ topScore: 0.8, threshold: 0.75, band: 0.05 }), 'high');
});

test('comfortably above: high', () => {
  assert.equal(confidenceBand({ topScore: 0.92, threshold: 0.75, band: 0.05 }), 'high');
});

test('band 0 disables hedging: at-threshold goes straight to high', () => {
  assert.equal(confidenceBand({ topScore: 0.75, threshold: 0.75, band: 0 }), 'high');
});

test('per-entity tuning: wider band, custom threshold', () => {
  assert.equal(confidenceBand({ topScore: 0.68, threshold: 0.6, band: 0.1 }), 'low');
  assert.equal(confidenceBand({ topScore: 0.71, threshold: 0.6, band: 0.1 }), 'high');
});

test('absent threshold/band fall back to defaults (0.75 / DEFAULT_BAND)', () => {
  assert.equal(DEFAULT_BAND, 0.05);
  assert.equal(confidenceBand({ topScore: 0.76 }), 'low');
  assert.equal(confidenceBand({ topScore: 0.81 }), 'high');
  assert.equal(confidenceBand({ topScore: 0.74 }), 'none');
});

test('non-numeric topScore: none', () => {
  assert.equal(confidenceBand({ topScore: undefined, threshold: 0.75, band: 0.05 }), 'none');
  assert.equal(confidenceBand({ topScore: null, threshold: 0.75, band: 0.05 }), 'none');
});
