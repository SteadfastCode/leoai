// Coverage for the baseline comparison in smoke.mjs (LEO-073).
//
// classify() takes both results as arguments, so every transition is driven here without a deploy,
// a network or a production box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './smoke.mjs';

const chk = (id, ok, detail = '') => ({ id, ok, status: ok ? 200 : 500, ms: 10, detail });
const run = (...checks) => ({ atUtc: '2026-10-12T00:00:00Z', checks });

test('green before, red after is a regression — the one case that reverts', () => {
  const v = classify(run(chk('chat', true)), run(chk('chat', false, 'HTTP 500')));
  assert.equal(v.ok, false);
  assert.deepEqual(v.regressions, ['chat']);
  assert.equal(v.rows[0].verdict, 'regression');
});

test('red before and red after is pre-existing, and must not revert healthy code', () => {
  // The 26-day outage: /chat was 500 before the merge and 500 after, and the all-green rule read
  // that as the merge breaking production.
  const v = classify(run(chk('chat', false, 'HTTP 500')), run(chk('chat', false, 'HTTP 500')));
  assert.equal(v.ok, true, 'the run may proceed');
  assert.deepEqual(v.preExisting, ['chat']);
  assert.deepEqual(v.regressions, []);
});

test('a pre-existing failure that changes its message is still pre-existing', () => {
  const v = classify(run(chk('chat', false, 'HTTP 500')), run(chk('chat', false, 'HTTP 502')));
  assert.equal(v.ok, true);
  assert.deepEqual(v.preExisting, ['chat']);
});

test('red before, green after is recovered — reported, never punished', () => {
  const v = classify(run(chk('chat', false)), run(chk('chat', true)));
  assert.equal(v.ok, true);
  assert.deepEqual(v.recovered, ['chat']);
});

test('one regression among healthy checks still fails the comparison', () => {
  const before = run(chk('health', true), chk('app', true), chk('chat', false));
  const after = run(chk('health', true), chk('app', false, 'asset 404'), chk('chat', false));
  const v = classify(before, after);
  assert.equal(v.ok, false);
  assert.deepEqual(v.regressions, ['app']);
  assert.deepEqual(v.preExisting, ['chat'], 'the known-bad one is still not blamed');
});

test('a baseline that could not be collected blocks outright', () => {
  // With nothing to compare against there is no way to tell a regression from a fault that was
  // already there, which is the only thing this comparison does.
  for (const missing of [null, undefined, {}, { checks: 'not an array' }]) {
    const v = classify(missing, run(chk('chat', true)));
    assert.equal(v.blocked, true);
    assert.equal(v.ok, false);
    assert.match(v.reason, /no baseline/);
  }
});

test('a skipped check is never a regression and never a pass', () => {
  const v = classify(run(chk('chat', null)), run(chk('chat', null)));
  assert.equal(v.rows[0].verdict, 'skipped');
  assert.deepEqual(v.regressions, []);
  // Skipped on one side only is still uncomparable, in both directions.
  assert.equal(classify(run(chk('chat', true)), run(chk('chat', null))).rows[0].verdict, 'skipped');
  assert.equal(classify(run(chk('chat', null)), run(chk('chat', false))).rows[0].verdict, 'skipped');
});

test('a check absent from the baseline cannot be compared, rather than counting as green', () => {
  // A newly added check has no "before". Treating its first red as a regression would revert a
  // merge for a check the previous run never ran.
  const v = classify(run(chk('health', true)), run(chk('health', true), chk('widget', false)));
  assert.equal(v.ok, true);
  assert.equal(v.rows.find((r) => r.id === 'widget').verdict, 'skipped');
});

test('every check reports which way it moved, so a summary can say what was already red', () => {
  const before = run(chk('health', true), chk('chat', false), chk('app', false));
  const after = run(chk('health', true), chk('chat', false), chk('app', true));
  const v = classify(before, after);
  assert.deepEqual(v.rows.map((r) => [r.id, r.verdict]), [['health', 'ok'], ['chat', 'pre-existing'], ['app', 'recovered']]);
});
