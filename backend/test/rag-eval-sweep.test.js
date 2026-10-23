// Retrieval threshold sweep (LEO-055).
//
// sweepThresholds is pure: it takes the per-question topScores rag-eval.js
// already collects and re-scores them against every candidate threshold. No DB,
// no network, no embedding call is involved here — the script owns all of that,
// and running it for real against live entities is Daniel's step.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sweepThresholds,
  thresholdRange,
  DEFAULT_THRESHOLDS,
} = require('../src/services/ragEval');

const at = (sweep, threshold) => sweep.levels.find((l) => l.threshold === threshold);

test('default candidates are 0.60–0.80 step 0.01, free of float drift', () => {
  assert.equal(DEFAULT_THRESHOLDS.length, 21);
  assert.equal(DEFAULT_THRESHOLDS[0], 0.6);
  assert.equal(DEFAULT_THRESHOLDS.at(-1), 0.8);
  // 0.6 + 0.01 is 0.6099999999999999 unrounded; every candidate must be the
  // same double as its decimal literal or `=== 0.61` lookups miss.
  assert.deepEqual(DEFAULT_THRESHOLDS.slice(0, 5), [0.6, 0.61, 0.62, 0.63, 0.64]);
  assert.ok(DEFAULT_THRESHOLDS.every((t) => t === Number(t.toFixed(2))));
});

test('all-miss: every score below the floor misses at every candidate', () => {
  const sweep = sweepThresholds([
    { id: 'hours-1', topScore: 0.41 },
    { id: 'hours-2', topScore: 0.5912 },
  ]);
  assert.equal(sweep.total, 2);
  for (const level of sweep.levels) {
    assert.equal(level.hitCount, 0);
    assert.equal(level.hitRate, 0);
    assert.deepEqual(level.hits, []);
    assert.deepEqual(level.misses, ['hours-1', 'hours-2']);
  }
});

test('all-hit: every score above the ceiling hits at every candidate', () => {
  const sweep = sweepThresholds([
    { id: 'a', topScore: 0.81 },
    { id: 'b', topScore: 0.97 },
  ]);
  for (const level of sweep.levels) {
    assert.equal(level.hitCount, 2);
    assert.equal(level.hitRate, 1);
    assert.deepEqual(level.hits, ['a', 'b']);
    assert.deepEqual(level.misses, []);
  }
});

test('a score exactly on a candidate counts as a hit (>= , matching retrieveContext)', () => {
  const sweep = sweepThresholds([{ id: 'on-the-line', topScore: 0.7 }]);
  assert.deepEqual(at(sweep, 0.69).hits, ['on-the-line']);
  assert.deepEqual(at(sweep, 0.7).hits, ['on-the-line'], '0.70 is a hit at threshold 0.70');
  assert.deepEqual(at(sweep, 0.71).hits, []);
  assert.deepEqual(at(sweep, 0.71).misses, ['on-the-line']);
});

test('empty set: levels still enumerated, hit-rate 0, distribution null', () => {
  const sweep = sweepThresholds([]);
  assert.equal(sweep.total, 0);
  assert.equal(sweep.levels.length, DEFAULT_THRESHOLDS.length);
  for (const level of sweep.levels) {
    assert.equal(level.hitRate, 0, 'no divide-by-zero NaN');
    assert.equal(level.total, 0);
    assert.deepEqual(level.hits, []);
    assert.deepEqual(level.misses, []);
  }
  assert.deepEqual(sweep.distribution, { min: null, median: null, max: null });
});

test('unsorted rows and unsorted candidates both come back ordered and correct', () => {
  const sweep = sweepThresholds(
    [
      { id: 'mid', topScore: 0.7 },
      { id: 'low', topScore: 0.63 },
      { id: 'high', topScore: 0.78 },
    ],
    [0.75, 0.6, 0.7],
  );
  assert.deepEqual(sweep.levels.map((l) => l.threshold), [0.6, 0.7, 0.75]);
  assert.deepEqual(at(sweep, 0.6).hits, ['mid', 'low', 'high'], 'hit list keeps row order, not score order');
  assert.deepEqual(at(sweep, 0.7).hits, ['mid', 'high']);
  assert.deepEqual(at(sweep, 0.7).misses, ['low']);
  assert.deepEqual(at(sweep, 0.75).hits, ['high']);
  // distribution sorts internally regardless of input order
  assert.deepEqual(sweep.distribution, { min: 0.63, median: 0.7, max: 0.78 });
});

test('LEO-037 shape: 0/12 at 0.75, and where the questions come back', () => {
  // The scores LEO-037 reported clustering 0.63–0.74 — the case this sweep exists for.
  const rows = [0.63, 0.65, 0.66, 0.68, 0.69, 0.7, 0.71, 0.72, 0.73, 0.735, 0.74, 0.74]
    .map((topScore, i) => ({ id: `q-${i + 1}`, topScore }));
  const sweep = sweepThresholds(rows);
  assert.equal(at(sweep, 0.75).hitCount, 0, 'the finding: nothing clears 0.75');
  assert.equal(at(sweep, 0.74).hitCount, 2);
  assert.equal(at(sweep, 0.7).hitCount, 7);
  assert.equal(at(sweep, 0.63).hitCount, 12, 'all twelve clear 0.63');
  assert.equal(at(sweep, 0.7).hitRate, 7 / 12);
  assert.equal(sweep.distribution.min, 0.63);
  assert.equal(sweep.distribution.max, 0.74);
  assert.equal(sweep.distribution.median, 0.705, 'even count: mean of the two middle scores');
});

test('median of an odd count is the middle score, not an average', () => {
  const sweep = sweepThresholds([{ topScore: 0.9 }, { topScore: 0.6 }, { topScore: 0.62 }]);
  assert.equal(sweep.distribution.median, 0.62);
});

test('a row with no usable score is a miss everywhere, and ids are filled in', () => {
  const sweep = sweepThresholds([
    { id: 'has-id', topScore: undefined },
    { topScore: 0.99 },
    { id: '', topScore: null },
  ]);
  assert.deepEqual(at(sweep, 0.6).hits, ['row-2'], 'positional fallback id');
  assert.deepEqual(at(sweep, 0.6).misses, ['has-id', 'row-3']);
  assert.equal(sweep.distribution.min, 0);
});

test('non-array rows and non-finite candidates are tolerated, not thrown on', () => {
  assert.equal(sweepThresholds(undefined).total, 0);
  assert.equal(sweepThresholds(null).levels.length, DEFAULT_THRESHOLDS.length);
  const sweep = sweepThresholds([{ id: 'a', topScore: 0.8 }], [0.7, NaN, undefined, 0.9]);
  assert.deepEqual(sweep.levels.map((l) => l.threshold), [0.7, 0.9]);
});

test('an explicitly empty candidate list yields no levels (no silent default)', () => {
  assert.deepEqual(sweepThresholds([{ id: 'a', topScore: 0.8 }], []).levels, []);
});

test('thresholdRange: custom bounds, degenerate and inverted inputs', () => {
  assert.deepEqual(thresholdRange(0.5, 0.52, 0.01), [0.5, 0.51, 0.52]);
  assert.deepEqual(thresholdRange(0.7, 0.7, 0.05), [0.7], 'min === max yields one candidate');
  assert.deepEqual(thresholdRange(0.8, 0.6, 0.01), [], 'inverted range yields nothing');
  assert.deepEqual(thresholdRange(0.6, 0.8, 0), [], 'zero step yields nothing, never an infinite loop');
  assert.deepEqual(thresholdRange(0.6, 0.8, NaN), []);
});
