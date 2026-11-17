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
  evalRow,
  thresholdRange,
  DEFAULT_THRESHOLDS,
  ENTITY_DEFAULT_THRESHOLD,
  NO_PAGE,
  OWNER_REPLY_PAGE,
  UNRETRIEVED_PAGE,
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

// ── LEO-117 ───────────────────────────────────────────────────────────────────
// Three defects the LEO-055 grader recorded: a step that does not divide the
// range emitted a candidate past max; an entity threshold outside 0.60–0.80 got
// a sweep table with no '← entity' row; and the hit flag and the page cell were
// computed from different comparisons, so the table printed hits with no page
// and pages beside misses.

test('thresholdRange: a step that does not divide the range stops inside max', () => {
  assert.deepEqual(thresholdRange(0.6, 0.8, 0.03), [0.6, 0.63, 0.66, 0.69, 0.72, 0.75, 0.78],
    'round() emitted a 7th step at 0.81, past max');
  assert.deepEqual(thresholdRange(0.6, 0.8, 0.07), [0.6, 0.67, 0.74], 'round() ended at 0.81');
  assert.deepEqual(thresholdRange(0.6, 0.8, 0.3), [0.6], 'a step wider than the range yields min alone');
});

test('thresholdRange: no candidate exceeds max, for any step from 0.01 to 0.11', () => {
  for (let i = 1; i <= 11; i++) {
    const step = i / 100;
    const range = thresholdRange(0.6, 0.8, step);
    assert.ok(range.length >= 1, `step ${step} yielded nothing`);
    assert.equal(range[0], 0.6, `step ${step} must start at min`);
    for (const t of range) assert.ok(t <= 0.8, `step ${step} emitted ${t}, past max`);
    // Ascending, evenly spaced, and the last candidate is the last one that fits.
    for (let j = 1; j < range.length; j++) {
      assert.ok(Math.abs(range[j] - range[j - 1] - step) < 1e-9, `step ${step} is uneven at index ${j}`);
    }
    assert.ok(range.at(-1) + step > 0.8 + 1e-9, `step ${step} stopped early at ${range.at(-1)}`);
  }
});

test('thresholdRange: a step that divides evenly still reaches max despite float drift', () => {
  // (0.3 - 0.1) / 0.05 is 3.9999999999999996, not 4 — the epsilon in the step
  // count is what keeps 0.30 in the list.
  assert.deepEqual(thresholdRange(0.1, 0.3, 0.05), [0.1, 0.15, 0.2, 0.25, 0.3]);
  assert.deepEqual(thresholdRange(0.6, 0.8, 0.05), [0.6, 0.65, 0.7, 0.75, 0.8]);
  assert.deepEqual(thresholdRange(0.6, 0.8, 0.1), [0.6, 0.7, 0.8]);
});

test("the entity's own threshold is always a swept level, below the floor or above the ceiling", () => {
  const rows = [
    { id: 'hours-1', topScore: 0.58 },
    { id: 'hours-2', topScore: 0.7 },
    { id: 'hours-3', topScore: 0.93 },
  ];

  for (const entityThreshold of [0.5, 0.55, 0.9, 0.95]) {
    const sweep = sweepThresholds(rows, DEFAULT_THRESHOLDS, entityThreshold);
    const own = sweep.levels.filter((l) => l.isEntityThreshold);
    assert.equal(own.length, 1, `exactly one '← entity' row at ${entityThreshold}`);
    assert.equal(own[0].threshold, entityThreshold, `a level equal to ${entityThreshold}`);
    assert.deepEqual(sweep.levels.map((l) => l.threshold).slice().sort((a, b) => a - b),
      sweep.levels.map((l) => l.threshold), 'levels stay ascending once the entity level is spliced in');
    assert.equal(sweep.levels.length, DEFAULT_THRESHOLDS.length + 1);
  }

  // Scored like any other level, not a cosmetic row.
  const low = at(sweepThresholds(rows, DEFAULT_THRESHOLDS, 0.55), 0.55);
  assert.deepEqual(low.hits, ['hours-1', 'hours-2', 'hours-3']);
  const high = at(sweepThresholds(rows, DEFAULT_THRESHOLDS, 0.9), 0.9);
  assert.deepEqual(high.hits, ['hours-3']);
  assert.deepEqual(high.misses, ['hours-1', 'hours-2']);
});

test('an entity threshold already among the candidates is flagged, never duplicated', () => {
  const sweep = sweepThresholds([{ id: 'a', topScore: 0.8 }], DEFAULT_THRESHOLDS, 0.75);
  assert.equal(sweep.levels.length, DEFAULT_THRESHOLDS.length, 'no extra row');
  assert.deepEqual(sweep.levels.filter((l) => l.isEntityThreshold).map((l) => l.threshold), [0.75]);
  // No entity threshold passed: nothing claims to be the entity's level.
  assert.ok(sweepThresholds([{ id: 'a', topScore: 0.8 }]).levels.every((l) => !l.isEntityThreshold));
  assert.ok(sweepThresholds([{ id: 'a', topScore: 0.8 }], DEFAULT_THRESHOLDS, NaN).levels
    .every((l) => !l.isEntityThreshold), 'a non-finite threshold is ignored, not inserted');
});

test('evalRow: a hit always carries a page, a miss never does', () => {
  const sources = [{ url: 'https://dosiedough.com/hours', name: 'Hours' }];
  // Either side of the sweep floor, the sweep ceiling, and the entity's own
  // threshold — the three boundaries the two columns used to disagree across.
  const scores = [0, 0.4, 0.5, 0.5499, 0.55, 0.5501, 0.5999, 0.6, 0.6001, 0.7,
    0.7999, 0.8, 0.8001, 0.8999, 0.9, 0.9001, 0.95, 1];

  for (const threshold of [0.5, 0.55, 0.6, 0.75, 0.8, 0.9, 0.95]) {
    for (const topScore of scores) {
      const row = evalRow({ topScore, hadContext: true, sources, threshold });
      assert.equal(row.hit, topScore >= threshold, `hit at ${topScore} vs ${threshold}`);
      assert.equal(row.topScore, topScore);
      assert.equal(row.threshold, threshold);
      if (row.hit) {
        assert.notEqual(row.page, NO_PAGE, `hit at ${topScore} vs ${threshold} printed no page`);
        assert.equal(row.page, 'https://dosiedough.com/hours');
      } else {
        assert.equal(row.page, NO_PAGE, `miss at ${topScore} vs ${threshold} printed a page`);
      }
    }
  }
});

test('evalRow: the two reported cases from the LEO-055 review', () => {
  const sources = [{ url: 'https://dosiedough.com/hours' }];
  // Entity below the sweep floor: 0.58 clears its 0.55, so it is a hit AND it
  // names the page. It used to print ✅ with '—'.
  const below = evalRow({ topScore: 0.58, hadContext: true, sources, threshold: 0.55 });
  assert.deepEqual([below.hit, below.page], [true, 'https://dosiedough.com/hours']);
  // Entity above the sweep ceiling: 0.70 misses its 0.90, so no page is named.
  // It used to print ❌ beside a page the entity will never cite.
  const above = evalRow({ topScore: 0.7, hadContext: true, sources, threshold: 0.9 });
  assert.deepEqual([above.hit, above.page], [false, NO_PAGE]);
});

test('evalRow: owner-reply-only and unretrieved hits say which they are', () => {
  assert.equal(evalRow({ topScore: 0.8, hadContext: true, sources: [], threshold: 0.75 }).page,
    OWNER_REPLY_PAGE, 'context but no page sources is an owner reply');
  const unretrieved = evalRow({ topScore: 0.8, hadContext: false, sources: [], threshold: 0.75 });
  assert.equal(unretrieved.page, UNRETRIEVED_PAGE, 'a hit the caller never retrieved says so');
  assert.notEqual(unretrieved.page, NO_PAGE, 'and still never reads as a miss');
  // A plain string source is tolerated, as the script once passed.
  assert.equal(evalRow({ topScore: 0.8, sources: ['/hours'], threshold: 0.75 }).page, '/hours');
  assert.equal(evalRow({ topScore: 0.8, hadContext: true, sources: [{ name: 'Hours' }], threshold: 0.75 }).page,
    'Hours', 'a source with no url falls back to its name');
});

test('evalRow: no arguments, no score and no threshold are tolerated', () => {
  assert.deepEqual(evalRow(), { topScore: 0, threshold: ENTITY_DEFAULT_THRESHOLD, hit: false, page: NO_PAGE });
  assert.equal(ENTITY_DEFAULT_THRESHOLD, 0.75, "matches ragThreshold's default in models/Entity.js");
  const missing = evalRow({ topScore: undefined, hadContext: false, sources: undefined, threshold: 0.5 });
  assert.deepEqual([missing.topScore, missing.hit, missing.page], [0, false, NO_PAGE]);
  // Threshold 0 is finite, so it is honoured rather than replaced by the default.
  assert.equal(evalRow({ topScore: 0, hadContext: true, sources: ['/x'], threshold: 0 }).hit, true);
});
