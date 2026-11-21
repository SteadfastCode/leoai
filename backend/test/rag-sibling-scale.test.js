// Tree siblings are scored on the same scale as the vector search (LEO-135).
//
// Phase 1 of retrieveContext filters on Atlas's `vectorSearchScore`, which for a
// cosine/dotProduct index is the NORMALISED similarity (1 + s) / 2. Phase 2 used
// to compare a RAW in-memory dot product against the same kind of bar, so a
// sibling had to clear a stricter test than the primary hit it was a sibling of.
//
// These tests pin the rule the item asks for: a sibling with raw dot d is kept
// exactly when (1 + d) / 2 >= siblingThreshold. Pure — no DB, no network; the
// functions under test are the ones rag.js calls at the decision point.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RAG_SCORE_LOG_LEVEL = process.env.RAG_SCORE_LOG_LEVEL || 'off';

const {
  dotProduct,
  normaliseSimilarity,
  siblingThresholdFor,
  keepSibling,
  SIBLING_THRESHOLD_OFFSET,
  MIN_SIBLING_THRESHOLD,
} = require('../src/services/ragScore');

// A query and a candidate whose dot product is EXACTLY d: multiplying by 1 and
// adding 0 is exact in floating point, so the boundary cases below are real
// boundary cases and not near-misses.
const Q = [1, 0, 0];
const vec = (d) => [d, 0, 0];

test('dotProduct is exact for the unit-axis vectors these tests use', () => {
  for (const d of [-1, -0.37, 0, 0.2, 0.45, 0.6, 1]) {
    assert.equal(dotProduct(Q, vec(d)), d);
  }
});

test('normaliseSimilarity maps a raw similarity onto the Atlas scale', () => {
  assert.equal(normaliseSimilarity(-1), 0);
  assert.equal(normaliseSimilarity(0), 0.5);
  assert.equal(normaliseSimilarity(0.5), 0.75);
  assert.equal(normaliseSimilarity(1), 1);
});

test('a sibling with raw dot d is kept exactly when (1 + d) / 2 >= siblingThreshold', () => {
  const bars = [0.5, 0.6, 0.65, 0.725, 0.8];
  const dots = [-1, -0.2, 0, 0.19, 0.2, 0.21, 0.3, 0.45, 0.5, 0.6, 0.75, 1];
  for (const bar of bars) {
    for (const d of dots) {
      const { keep, score } = keepSibling(Q, vec(d), bar);
      assert.equal(score, (1 + d) / 2, `score for raw ${d}`);
      assert.equal(keep, (1 + d) / 2 >= bar, `raw ${d} against bar ${bar}`);
    }
  }
});

test('the bar is a boundary, not a gap: exactly at it is kept, a hair under is not', () => {
  // (1 + 0.2) / 2 === 0.6 exactly, in IEEE-754 as on paper.
  assert.equal(keepSibling(Q, vec(0.2), 0.6).keep, true);
  assert.equal(keepSibling(Q, vec(0.19999), 0.6).keep, false);
  assert.equal(keepSibling(Q, vec(0.20001), 0.6).keep, true);
});

test('the score handed back is on the Atlas scale, so it is comparable with a primary hit', () => {
  // Phase 1 would report a chunk at raw 0.45 as 0.725; so must Phase 2, since
  // packContext mixes both lists and sorts siblings by this number.
  const { score } = keepSibling(Q, vec(0.45), 0.6);
  assert.equal(score, 0.725);
});

test('LEO-135 regression: the sibling the raw comparison dropped is now kept', () => {
  const threshold = 0.75; // the default ragThreshold
  const bar = siblingThresholdFor(threshold);
  assert.equal(bar, 0.6);

  const raw = 0.45;
  assert.equal(raw >= bar, false, 'the old raw comparison dropped this sibling');
  assert.equal(normaliseSimilarity(raw) >= bar, true, 'the normalised one keeps it');
  assert.equal(keepSibling(Q, vec(raw), bar).keep, true);
});

test('the sibling bar is never stricter than the primary threshold it came from', () => {
  // The whole point of Phase 2: a chunk that would have passed Phase 1 must
  // always pass as a sibling. Swept over the full ragThreshold range
  // (models/Entity.js: min 0.5, max 0.95).
  for (let t = 0.5; t <= 0.9501; t += 0.01) {
    const threshold = Number(t.toFixed(2));
    const bar = siblingThresholdFor(threshold);
    assert.ok(bar <= threshold, `bar ${bar} must not exceed threshold ${threshold}`);
    // A sibling scoring exactly what Phase 1 demands is kept.
    const rawAtThreshold = 2 * threshold - 1;
    assert.equal(keepSibling(Q, vec(rawAtThreshold), bar).keep, true, `at threshold ${threshold}`);
  }
});

test('siblingThresholdFor applies the offset, then the floor', () => {
  assert.equal(siblingThresholdFor(0.95), 0.95 - SIBLING_THRESHOLD_OFFSET);
  assert.equal(siblingThresholdFor(0.8), 0.8 - SIBLING_THRESHOLD_OFFSET);
  // At and below 0.65 the offset would go under the floor.
  assert.equal(siblingThresholdFor(0.65), MIN_SIBLING_THRESHOLD);
  assert.equal(siblingThresholdFor(0.6), MIN_SIBLING_THRESHOLD);
  assert.equal(siblingThresholdFor(0.5), MIN_SIBLING_THRESHOLD);
  // The floor is the "no similarity" point of the normalised scale: a sibling
  // can never be admitted on a negative cosine.
  assert.equal(MIN_SIBLING_THRESHOLD, normaliseSimilarity(0));
});

test('a candidate with no usable embedding is skipped, not thrown on', () => {
  for (const bad of [undefined, null, [], [0.5, 0.5], [1, 0, 0, 0], 'nope', 42]) {
    const result = keepSibling(Q, bad, 0.6);
    assert.deepEqual(result, { keep: false, score: 0 });
  }
  // A full-length embedding is still scored normally.
  assert.equal(keepSibling(Q, vec(0.9), 0.6).keep, true);
});

test('log tiers are inert at off and never throw at any tier', () => {
  const original = process.env.RAG_SCORE_LOG_LEVEL;
  const lines = [];
  const realLog = console.log;
  console.log = (msg) => lines.push(String(msg));
  try {
    for (const tier of ['off', 'light', 'normal', 'verbose', 'nonsense']) {
      process.env.RAG_SCORE_LOG_LEVEL = tier;
      const before = lines.length;
      const bar = siblingThresholdFor(0.75);
      keepSibling(Q, vec(0.45), bar, 'https://example.com/staff');
      keepSibling(Q, undefined, bar, 'https://example.com/broken');
      if (tier === 'off') assert.equal(lines.length, before, 'off must be silent');
      else assert.ok(lines.length > before, `${tier} must log something`);
    }
    // The normal tier names the source of the change, not just the new value.
    const changed = lines.filter((l) => l.includes('LEO-135 normalised scale'));
    assert.ok(changed.length > 0);
    assert.ok(changed[0].includes('raw dot 0.4500'));
    assert.ok(lines.some((l) => l.includes('https://example.com/broken')));
  } finally {
    console.log = realLog;
    process.env.RAG_SCORE_LOG_LEVEL = original;
  }
});
