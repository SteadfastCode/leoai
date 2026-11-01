// Tiered model-routing gate (LEO-079).
//
// selectModel() picks the model for every visitor message from four rules, in
// order: Church Mode wins, then a message over 500 characters, then anything the
// classifier did not label exactly 'simple'; only what survives all three gets
// Haiku. It is the cost lever docs/pricing-strategy.md sizes the plans against,
// and a one-character regression goes both ways — every simple question on Sonnet
// quietly multiplies the API bill, Church Mode on Haiku quietly lowers the answers
// Leo gives where he is least allowed to be sloppy. The `model` / `classifierRoute`
// fields stored on each assistant message record what happened; this file asserts
// what should.
//
// The decision is pure — no DB, no network, no model call — so the whole matrix is
// asserted directly against the real claude.js (chat-flow.test.js stubs the module
// out entirely, so it can never cover this).
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectModel } = require('../src/services/claude');

// The only place this file names a model id. A deliberate model upgrade is a
// one-line change here and the matrix below still holds.
const MODELS = {
  complex: 'claude-sonnet-4-6',
  simple: 'claude-haiku-4-5-20251001',
};

// What classifyQuery() returns for a single-fact lookup.
const SIMPLE = { route: 'simple', reason: 'hours lookup' };

const chars = n => 'a'.repeat(n);

test('selectModel is exported — the lever is reachable from a test at all', () => {
  assert.equal(typeof selectModel, 'function');
});

test('Church Mode overrides a simple classification → Sonnet', () => {
  assert.equal(
    selectModel({ churchModeEnabled: true }, 'What time is the service?', SIMPLE),
    MODELS.complex,
  );
});

test('exactly 500 characters is still short → Haiku', () => {
  assert.equal(selectModel({}, chars(500), SIMPLE), MODELS.simple);
});

test('501 characters crosses the boundary → Sonnet', () => {
  assert.equal(selectModel({}, chars(501), SIMPLE), MODELS.complex);
});

test('no classifier result at all → Sonnet (conservative fallback)', () => {
  assert.equal(selectModel({}, 'What are your hours?', null), MODELS.complex);
  assert.equal(selectModel({}, 'What are your hours?', undefined), MODELS.complex);
});

test('an explicitly complex classification → Sonnet', () => {
  assert.equal(
    selectModel({}, 'But you said you were open Sundays?', { route: 'complex', reason: 'pushback' }),
    MODELS.complex,
  );
});

test('a shapeless classifier result → Sonnet', () => {
  assert.equal(selectModel({}, 'What are your hours?', {}), MODELS.complex);
});

test('route matching is case-sensitive: "SIMPLE" is not simple → Sonnet', () => {
  assert.equal(selectModel({}, 'What are your hours?', { route: 'SIMPLE' }), MODELS.complex);
});

test('simple, short, Church Mode off → Haiku', () => {
  assert.equal(selectModel({ churchModeEnabled: false }, 'What are your hours?', SIMPLE), MODELS.simple);
  assert.equal(selectModel({}, 'What are your hours?', SIMPLE), MODELS.simple);
});

test('an absent userMessage neither throws nor trips the length override', () => {
  assert.equal(selectModel({}, '', SIMPLE), MODELS.simple);
  assert.equal(selectModel({}, null, SIMPLE), MODELS.simple);
  assert.equal(selectModel({}, undefined, SIMPLE), MODELS.simple);
});
