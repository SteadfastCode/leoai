// Report-only LeoScan sweep over scraped chunks (LEO-060).
//
// The sweep exists to say "a secret is sitting on this page" without ever
// becoming a reason to drop a chunk, and without copying the secret anywhere.
// So the assertions split three ways:
//   1. it finds what LeoScan finds, keyed by URL (and by every member URL of a
//      group chunk, which is the only URL a thin page has a row under);
//   2. nothing it returns, stores or logs contains the matched text;
//   3. the 28-chunk real-world negative corpus LEO-021 validated against still
//      sweeps to zero — a false positive here is a false warning chip on a real
//      customer page.
//
// All secrets below are fabricated fixtures, not real credentials.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');

const { sweepChunks, mergeSweep, logSweep } = require('../src/services/scanSweep');

const DOMAIN = 'scratch.leo-nightly.test';
const PAGE = `https://${DOMAIN}/wifi`;
const GROUP = `https://${DOMAIN}/staff/`;

// A labelled password: the one rule the item names, and the one most likely to
// turn up on a real page (a "guest wifi" or "member portal" card).
const SECRET = 'hunter2AB';
const FLAGGED_TEXT = `Guest wifi is open to all. password: ${SECRET}`;

const chunk = (url, content, extra = {}) => ({ url, content, sourceUrls: [url], ...extra });

// ── What it finds ──────────────────────────────────────────────────────────

test('clean chunks yield no findings at all', () => {
  const clean = [
    chunk(PAGE, 'Open Tuesday to Saturday, 7am to 3pm. Closed Sundays.'),
    chunk(`https://${DOMAIN}/menu`, 'Sourdough loaf $8.50 — call (717) 626-2266 to reserve.'),
    chunk(`https://${DOMAIN}/about`, 'We are password protected on the staff portal only.'),
  ];
  assert.deepEqual(sweepChunks(clean), []);
});

test('a chunk with a labelled password yields its URL and the rule name', () => {
  const findings = sweepChunks([chunk(PAGE, FLAGGED_TEXT)]);
  assert.deepEqual(findings, [{ url: PAGE, rules: ['labelled_password'] }]);
});

test('a URL is reported once with its rules deduped and sorted', () => {
  const findings = sweepChunks([
    chunk(PAGE, FLAGGED_TEXT),
    chunk(PAGE, 'and again, pwd=othersecret1'),
    chunk(PAGE, 'token sk-abcdefghijklmnopqrstuv1234 in a code sample'),
  ]);
  assert.equal(findings.length, 1, 'one entry per URL, not per chunk');
  assert.equal(findings[0].url, PAGE);
  assert.deepEqual(findings[0].rules, ['api_key', 'labelled_password']);
});

test('a group chunk credits every URL in its sourceUrls', () => {
  const members = [`${GROUP}ann`, `${GROUP}bob`, `${GROUP}cara`];
  const findings = sweepChunks([
    { url: GROUP, content: `[H1] Ann\n${FLAGGED_TEXT}`, sourceUrls: members },
  ]);

  const flagged = findings.map((f) => f.url).sort();
  for (const member of members) {
    assert.ok(flagged.includes(member), `${member} must be credited — it is the only row a thin page has`);
  }
  assert.ok(flagged.includes(GROUP), 'the group URL itself is credited too');
  assert.ok(findings.every((f) => f.rules.length === 1 && f.rules[0] === 'labelled_password'));
});

test('a chunk with no sourceUrls is still keyed by its own url', () => {
  assert.deepEqual(sweepChunks([{ url: PAGE, content: FLAGGED_TEXT }]), [
    { url: PAGE, rules: ['labelled_password'] },
  ]);
});

test('malformed input is swept without throwing', () => {
  assert.deepEqual(sweepChunks(undefined), []);
  assert.deepEqual(sweepChunks(null), []);
  assert.deepEqual(sweepChunks([]), []);
  assert.deepEqual(sweepChunks([null, undefined, {}, { url: PAGE }, { content: FLAGGED_TEXT }]), [],
    'a chunk with no url has nowhere to report a finding, and a chunk with no content cannot trip');
});

// ── What it must never leak ────────────────────────────────────────────────

test('the serialized findings contain none of the matched secret text', () => {
  const findings = sweepChunks([
    chunk(PAGE, FLAGGED_TEXT),
    chunk(`https://${DOMAIN}/dev`, 'key sk-abcdefghijklmnopqrstuv1234 live'),
    chunk(`https://${DOMAIN}/hr`, 'ssn 123-45-6789 on file'),
  ]);
  const serialized = JSON.stringify(findings);

  assert.ok(findings.length === 3, 'all three pages tripped');
  for (const leak of [SECRET, 'hunter2', 'sk-abcdefghijklmnopqrstuv1234', 'sk-abcde', '123-45-6789']) {
    assert.ok(!serialized.includes(leak), `findings leaked ${leak.slice(0, 4)}…`);
  }
  // scanText's own redacted previews must not survive into the report either.
  assert.ok(!serialized.includes('preview'), 'rule names only — no previews');
  assert.ok(!/chars\)/.test(serialized), 'no redacted preview text');
});

test('no log tier prints the matched text, and light logs one line per scrape', () => {
  const byUrl = mergeSweep({}, sweepChunks([
    chunk(PAGE, FLAGGED_TEXT),
    chunk(`https://${DOMAIN}/dev`, 'key sk-abcdefghijklmnopqrstuv1234 live'),
  ]));

  const original = console.log;
  const priorLevel = process.env.SCAN_SWEEP_LOG_LEVEL;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    process.env.SCAN_SWEEP_LOG_LEVEL = 'light';
    logSweep(DOMAIN, byUrl, 2);
    assert.equal(lines.length, 1, 'light tier is one line for the whole scrape');
    assert.match(lines[0], /2 URL\(s\) tripped/);
    assert.match(lines[0], /api_key/);
    assert.match(lines[0], /labelled_password/);

    lines.length = 0;
    process.env.SCAN_SWEEP_LOG_LEVEL = 'verbose';
    logSweep(DOMAIN, byUrl, 2);
    assert.equal(lines.length, 3, 'verbose adds one line per flagged URL — never per chunk');

    lines.length = 0;
    process.env.SCAN_SWEEP_LOG_LEVEL = 'off';
    logSweep(DOMAIN, byUrl, 2);
    assert.equal(lines.length, 0, 'off is silent');

    lines.length = 0;
    process.env.SCAN_SWEEP_LOG_LEVEL = 'light';
    logSweep(DOMAIN, {}, 12);
    assert.equal(lines.length, 0, 'light says nothing when nothing tripped');
    process.env.SCAN_SWEEP_LOG_LEVEL = 'normal';
    logSweep(DOMAIN, {}, 12);
    assert.equal(lines.length, 1, 'normal reports the clean sweep');
  } finally {
    console.log = original;
    if (priorLevel === undefined) delete process.env.SCAN_SWEEP_LOG_LEVEL;
    else process.env.SCAN_SWEEP_LOG_LEVEL = priorLevel;
  }

  const logged = lines.join('\n');
  assert.ok(!logged.includes(SECRET) && !logged.includes('sk-abcde'), 'a log line must never carry the match');
});

// ── Accumulating across batches ────────────────────────────────────────────

test('mergeSweep unions rules per URL across batches', () => {
  const into = {};
  mergeSweep(into, sweepChunks([chunk(PAGE, FLAGGED_TEXT)]));
  mergeSweep(into, sweepChunks([chunk(PAGE, 'key sk-abcdefghijklmnopqrstuv1234 live')]));
  mergeSweep(into, sweepChunks([chunk(`https://${DOMAIN}/menu`, 'Sourdough $8.50')]));

  assert.deepEqual(Object.keys(into), [PAGE], 'only the flagged URL gets a key');
  assert.deepEqual(into[PAGE], ['api_key', 'labelled_password']);
  assert.deepEqual(mergeSweep({}, []), {});
  assert.deepEqual(mergeSweep({}, undefined), {});
});

// ── The check that decides safety ──────────────────────────────────────────

test('the real-world negative corpus sweeps to zero findings', () => {
  const corpus = require('./fixtures/leoscan-negative-corpus.json');
  assert.ok(corpus.length >= 20, `corpus size ${corpus.length} is too small to mean anything`);
  assert.deepEqual(
    sweepChunks(corpus),
    [],
    'a false positive here is a false warning chip on a real customer page'
  );
});
