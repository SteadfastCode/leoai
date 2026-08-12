// Shared question-similarity logic (LEO-017).
//
// Pure-function tests on the extracted service — no DB, no network. The DB
// mutation in the owner-reply handler cannot be exercised offline; these
// tests pin the matching behavior it relies on.

const test = require('node:test');
const assert = require('node:assert/strict');

const { questionSimilarity, SIMILARITY_THRESHOLD } = require('../src/services/questions');

test('identical strings score 1', () => {
  assert.equal(questionSimilarity('What are your hours?', 'What are your hours?'), 1);
});

test('case and punctuation are ignored', () => {
  assert.equal(questionSimilarity('WHAT ARE YOUR HOURS?!', 'what are your hours'), 1);
});

test('word order is ignored (set semantics)', () => {
  assert.equal(questionSimilarity('hours your are what', 'what are your hours'), 1);
});

test('two empty strings score 1 (defined edge case)', () => {
  assert.equal(questionSimilarity('', ''), 1);
});

test('empty vs non-empty scores 0', () => {
  assert.equal(questionSimilarity('', 'what are your hours'), 0);
});

test('disjoint questions score 0', () => {
  assert.equal(questionSimilarity('do you ship internationally', 'what are your hours'), 0);
});

test('rephrasings of the same question clear the threshold', () => {
  const s = questionSimilarity(
    'What are your opening hours?',
    'What are your opening hours today?'
  );
  assert.ok(s >= SIMILARITY_THRESHOLD, `expected ${s} >= ${SIMILARITY_THRESHOLD}`);
});

test('different questions sharing filler words stay under the threshold', () => {
  const s = questionSimilarity(
    'What are your opening hours?',
    'What are your delivery fees?'
  );
  assert.ok(s < SIMILARITY_THRESHOLD, `expected ${s} < ${SIMILARITY_THRESHOLD}`);
});

test('partial overlap computes intersection over union', () => {
  // words: {a b c} vs {b c d} — intersection 2, union 4
  assert.equal(questionSimilarity('a b c', 'b c d'), 0.5);
});

test('threshold constant is the documented 0.6', () => {
  assert.equal(SIMILARITY_THRESHOLD, 0.6);
});

test('routes still agree with the service (no drift after extraction)', () => {
  // chat.js and dashboard.js must consume the shared implementation rather
  // than re-declaring their own copy.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const rel of ['../src/routes/chat.js', '../src/routes/dashboard.js']) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(src.includes("require('../services/questions')"), `${rel} imports the service`);
    assert.ok(!src.includes('function questionSimilarity'), `${rel} has no local copy`);
  }
});
