// Dead-page retirement, the decision half (LEO-138).
//
// planRetirement is pure — no database, no mutation — so every rule and every
// guard is asserted here against hand-built crawl results. The half that writes
// (and what the snapshot archives before it does) is driven through the real
// persistRescrapeResult in scrape-persist.test.js.
//
// The rules under test, in one sentence each: a 404 retires at once, any other
// failure never retires, two consecutive misses retire, and three guards refuse
// to retire anything at all when the crawl itself looks broken.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  planRetirement,
  reachedKeys,
  pageKey,
  MAX_MISSES,
  MIN_REACH_RATIO,
  MIN_RETIRE_FLOOR,
} = require('../src/services/pageRetire');
const { MAX_PAGES } = require('../src/services/crawlLimits');

const DOMAIN = 'retire.leo-nightly.test';
const u = (p) => `https://${DOMAIN}${p}`;

// A healthy-looking crawl: enough reached pages that no guard trips.
const LIVE = ['/', '/about', '/contact', '/hours', '/menu', '/staff'];
const stored = (paths, missedCrawls = 0) => paths.map((p) => ({ url: u(p), missedCrawls }));
const reaching = (paths) => ({ unchangedUrls: paths.map(u) });

test('a page the crawl reached is never retired', () => {
  const plan = planRetirement({ storedPages: stored(LIVE), result: reaching(LIVE), domain: DOMAIN });
  assert.deepEqual(plan.retire, []);
  assert.deepEqual(plan.bump, []);
  assert.equal(plan.skipped, null);
});

test('a page the crawl did not reach takes a miss first, and is retired on the second', () => {
  const first = planRetirement({ storedPages: stored([...LIVE, '/holy-week']), result: reaching(LIVE), domain: DOMAIN });
  assert.deepEqual(first.retire, [], 'one missed crawl is not evidence enough');
  assert.deepEqual(first.bump, [u('/holy-week')]);

  const second = planRetirement({
    storedPages: [...stored(LIVE), { url: u('/holy-week'), missedCrawls: MAX_MISSES - 1 }],
    result: reaching(LIVE),
    domain: DOMAIN,
  });
  assert.deepEqual(second.retire.map((r) => r.url), [u('/holy-week')]);
  assert.equal(second.retire[0].reason, 'unreached');
});

test('a page that is reached again has its miss counter cleared', () => {
  const plan = planRetirement({
    storedPages: [...stored(LIVE), { url: u('/holy-week'), missedCrawls: 1 }],
    result: reaching([...LIVE, '/holy-week']),
    domain: DOMAIN,
  });
  assert.deepEqual(plan.retire, []);
  assert.deepEqual(plan.reset, [u('/holy-week')]);
});

test('a 404 retires the page on the spot', () => {
  const plan = planRetirement({
    storedPages: stored([...LIVE, '/holy-week']),
    result: { ...reaching(LIVE), failedUrls: [{ url: u('/holy-week'), reason: 'http_error', status: 404 }] },
    domain: DOMAIN,
  });
  assert.deepEqual(plan.retire.map((r) => r.url), [u('/holy-week')]);
  assert.equal(plan.retire[0].reason, 'gone');
  assert.deepEqual(plan.bump, [], 'a gone page is not also counted as merely missed');
});

test('a 410 retires the page on the spot too', () => {
  const plan = planRetirement({
    storedPages: stored([...LIVE, '/holy-week']),
    result: { ...reaching(LIVE), failedUrls: [{ url: u('/holy-week'), reason: 'http_error', status: 410 }] },
    domain: DOMAIN,
  });
  assert.deepEqual(plan.retire.map((r) => r.url), [u('/holy-week')]);
});

// The whole difference between "gone" and "down". A timeout tonight must cost a
// page nothing at all — not its chunks, and not a miss off its grace either.
for (const failure of [
  { label: 'a timeout', entry: { reason: 'fetch_error', status: null } },
  { label: 'a 500', entry: { reason: 'http_error', status: 500 } },
  { label: 'a 403', entry: { reason: 'http_error', status: 403 } },
  { label: 'an empty render', entry: { reason: 'empty_after_render', status: null } },
]) {
  test(`${failure.label} never retires the page, and does not spend its grace`, () => {
    const plan = planRetirement({
      storedPages: [...stored(LIVE), { url: u('/holy-week'), missedCrawls: MAX_MISSES - 1 }],
      result: { ...reaching(LIVE), failedUrls: [{ url: u('/holy-week'), ...failure.entry }] },
      domain: DOMAIN,
    });
    assert.deepEqual(plan.retire, [], `${failure.label} must not retire a page`);
    assert.deepEqual(plan.bump, [], `${failure.label} must not add a miss`);
    assert.deepEqual(plan.reset, [u('/holy-week')], 'the crawl did reach it, so its counter clears');
  });
}

test('the crawl hitting the page cap retires nothing', () => {
  const many = Array.from({ length: MAX_PAGES }, (_, i) => `/p${i}`);
  const plan = planRetirement({
    storedPages: stored([...many, '/beyond-the-cap'], MAX_MISSES - 1),
    result: reaching(many),
    domain: DOMAIN,
  });
  assert.deepEqual(plan.retire, []);
  assert.match(plan.skipped, /page cap/);
});

test('a crawl that reached almost nothing retires nothing', () => {
  const plan = planRetirement({
    storedPages: stored(LIVE, MAX_MISSES - 1),
    result: reaching(['/']),
    domain: DOMAIN,
  });
  assert.deepEqual(plan.retire, []);
  assert.deepEqual(plan.bump, [], 'a bad night must not spend any page\'s grace');
  assert.match(plan.skipped, new RegExp(`${Math.round(MIN_REACH_RATIO * 100)}% floor`));
});

test('a server answering 404 to everything retires nothing', () => {
  const paths = Array.from({ length: 30 }, (_, i) => `/p${i}`);
  const plan = planRetirement({
    storedPages: stored(paths),
    result: { failedUrls: paths.map((p) => ({ url: u(p), reason: 'http_error', status: 404 })) },
    domain: DOMAIN,
  });
  assert.deepEqual(plan.retire, []);
  assert.match(plan.skipped, /allowance/);
});

test('a small site can still retire its one dead page', () => {
  const paths = ['/', '/about', '/gone'];
  const plan = planRetirement({
    storedPages: stored(paths),
    result: { unchangedUrls: [u('/'), u('/about')], failedUrls: [{ url: u('/gone'), reason: 'http_error', status: 404 }] },
    domain: DOMAIN,
  });
  assert.deepEqual(plan.retire.map((r) => r.url), [u('/gone')], `up to ${MIN_RETIRE_FLOOR} pages are always retirable`);
});

test('an empty stored-page list is a no-op, not a crash', () => {
  const plan = planRetirement({ storedPages: [], result: reaching(LIVE) });
  assert.deepEqual(plan, { retire: [], bump: [], reset: [], skipped: null });
  assert.deepEqual(planRetirement(), { retire: [], bump: [], reset: [], skipped: null });
  assert.deepEqual(planRetirement({ storedPages: [null, { missedCrawls: 1 }], result: {} }).retire, []);
});

// --- what counts as "the crawl reached this page" ---------------------------

test('every kind of evidence in a result counts as reached', () => {
  const keys = reachedKeys({
    pageHashUpdates: [{ url: u('/changed') }],
    unchangedUrls: [u('/same')],
    changedUrls: [u('/changed')],
    skippedUrls: [u('/embed-failed')],
    thinGroupUrls: [u('/staff')],
    robotsDisallowed: [u('/disallowed')],
    failedUrls: [{ url: u('/timed-out'), reason: 'fetch_error', status: null }],
    embeddedChunks: [{ url: u('/changed'), sourceUrls: [u('/changed')] }],
    thinGroupChunks: [{ url: u('/staff'), sourceUrls: [u('/staff/ann'), u('/staff/bob')] }],
  });
  for (const p of ['/changed', '/same', '/embed-failed', '/staff', '/disallowed', '/timed-out', '/staff/ann', '/staff/bob']) {
    assert.ok(keys.has(pageKey(u(p))), `${p} must count as reached`);
  }
  assert.ok(!keys.has(pageKey(u('/never-mentioned'))));
});

test('a thin page named only inside a group chunk is never retired for it', () => {
  const plan = planRetirement({
    storedPages: [...stored(LIVE), { url: u('/staff/ann'), missedCrawls: MAX_MISSES - 1 }],
    result: {
      ...reaching(LIVE),
      thinGroupUrls: [u('/staff')],
      thinGroupChunks: [{ url: u('/staff'), sourceUrls: [u('/staff/ann')] }],
    },
    domain: DOMAIN,
  });
  assert.deepEqual(plan.retire, [], 'a page folded into a group chunk WAS crawled');
  assert.deepEqual(plan.reset, [u('/staff/ann')]);
});

test('a row stored under a pre-LEO-137 spelling is matched to the page the crawl read', () => {
  // http for https, www for bare, trailing slash: the same page, three ways.
  const plan = planRetirement({
    storedPages: [
      ...stored(LIVE),
      { url: `http://${DOMAIN}/about`, missedCrawls: MAX_MISSES - 1 },
    ],
    result: reaching(LIVE),
    domain: DOMAIN,
  });
  assert.deepEqual(plan.retire, [], 'a scheme-only difference is a spelling, not a dead page');
  assert.deepEqual(plan.reset, [`http://${DOMAIN}/about`]);
});
