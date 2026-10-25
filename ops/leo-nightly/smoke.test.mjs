// Coverage for the baseline comparison in smoke.mjs (LEO-073).
//
// classify() takes both results as arguments, so every transition is driven here without a deploy,
// a network or a production box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, collectability } from './smoke.mjs';

const chk = (id, ok, detail = '') => ({ id, ok, status: ok ? 200 : 500, ms: 10, detail });
// status 0 is the smoke's "no HTTP response at all"; null is a check that never ran (LEO-095).
const down = (id) => ({ id, ok: false, status: 0, ms: 20_000, detail: 'fetch failed' });
const skip = (id) => ({ id, ok: null, status: null, ms: 0, detail: 'skipped: no LEO_ADMIN_API_KEY' });
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

// --- collectability(): "could not collect" is not the same as "red" (LEO-095) ---------------

test('the baseline that actually ships — chat 500, search skipped — is collected', () => {
  // Both hosts answered. A 500 from /chat is a reply: blocking on it is the 26-day mistake.
  const v = collectability([chk('health', true), chk('app', true), chk('chat', false, 'HTTP 500'), skip('search'), chk('widget', true)]);
  assert.deepEqual(v, { collected: true, unreachable: [] });
});

test('production entirely unreachable is NOT a collected baseline, however red it looks', () => {
  // Five reds and exit 0 was the bug: this baseline then excused every post-merge failure.
  const v = collectability([down('health'), down('app'), down('chat'), skip('search'), down('widget')]);
  assert.equal(v.collected, false);
  assert.deepEqual(v.unreachable, ['api', 'app']);
});

test('one host down and the other up still blocks, naming only the host that was never reached', () => {
  // Railway down, Netlify up: four checks that can say nothing, so a failed deploy serving the
  // wrong commit would later read as pre-existing.
  const v = collectability([down('health'), chk('app', true), down('chat'), skip('search'), down('widget')]);
  assert.equal(v.collected, false);
  assert.deepEqual(v.unreachable, ['api']);
});

test('one check reaching a host vouches for it, even when every other check on it is down', () => {
  const v = collectability([chk('health', true), chk('app', true), down('chat'), skip('search'), down('widget')]);
  assert.deepEqual(v, { collected: true, unreachable: [] });
});

test('an HTTP error status is a reached host — a 404 or a 502 is still an answer', () => {
  const v = collectability([{ id: 'health', ok: false, status: 502, ms: 10, detail: 'HTTP 502' }, chk('app', true)]);
  assert.deepEqual(v, { collected: true, unreachable: [] });
});

test('a skipped check neither condemns nor vouches for its host', () => {
  // search skips whenever there is no admin key, which is the ordinary case and collected...
  assert.equal(collectability([skip('search'), chk('health', true), chk('app', true)]).collected, true);
  // ...but it cannot stand in for a reply when every other check on its host got none.
  assert.deepEqual(collectability([skip('search'), down('health'), chk('app', true)]).unreachable, ['api']);
});

test('nothing probed at all is not a collected baseline either', () => {
  assert.deepEqual(collectability([]), { collected: false, unreachable: [] });
  assert.equal(collectability([skip('search')]).collected, false);
});

test('an unlisted check id stands as its own host, so a forgotten map entry fails loudly', () => {
  const v = collectability([chk('health', true), chk('app', true), down('newthing')]);
  assert.equal(v.collected, false);
  assert.deepEqual(v.unreachable, ['newthing']);
});

// --- classify(): a baseline that was never collected is refused, not compared ---------------

test('a baseline marked uncollectable blocks instead of excusing a regression', () => {
  const baseline = { ...run(down('health'), down('chat')), collected: false, unreachable: ['api'] };
  const v = classify(baseline, run(chk('health', false, 'serving the wrong commit'), chk('chat', false)));
  assert.equal(v.blocked, true);
  assert.equal(v.ok, false);
  assert.match(v.reason, /could not be collected: api unreachable/);
});

test('a baseline written before collected existed is still usable, not blocked', () => {
  // `=== false` on purpose: the field is absent in every baseline file written before LEO-095.
  const v = classify(run(chk('chat', false)), run(chk('chat', false)));
  assert.equal(v.blocked, false);
  assert.equal(v.ok, true);
  assert.deepEqual(v.preExisting, ['chat']);
});
