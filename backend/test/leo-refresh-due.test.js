// LeoRefresh due-calculation + re-entrancy contracts (LEO-077).
//
// Two halves:
//   1. The pure predicate. `isDueNow` was a bare UTC-hour equality, so one
//      missed cron fire — a container restart spanning the hour — cost a daily
//      entity a whole day and a weekly one a whole week, silently. The catch-up
//      arm must fix that WITHOUT ever letting the same entity refresh twice in
//      one period, so every assertion here is one of two kinds: "a missed slot
//      is recovered" or "a second run in the same period is impossible".
//   2. The tick's re-entrancy flag, driven through the real `runHourlyTick`
//      with the models and the scraper stubbed out: two overlapping calls must
//      put exactly ONE crawl in flight. The sequential loop inside a tick does
//      nothing about the next hour's fire landing on top of a running one, and
//      two concurrent Puppeteer crawls is what it exists to prevent.
//
// The models, the scraper and the persistence path are stubbed via require.cache
// before the service loads, so nothing here touches Mongo, Puppeteer, Voyage or
// a person.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'src');

function stubModule(resolvedPath, exportsObject) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsObject,
  };
}

// --- stubs ------------------------------------------------------------------

let enabledEntities = [];
let stampedDomains = [];

stubModule(require.resolve(path.join(srcDir, 'models', 'Entity.js')), {
  find: async () => enabledEntities,
  findOne: async () => null,
  findOneAndUpdate: async (filter) => {
    stampedDomains.push(filter.domain);
    return {};
  },
});
stubModule(require.resolve(path.join(srcDir, 'models', 'ScrapedPage.js')), {
  find: async () => [],
});
stubModule(require.resolve(path.join(srcDir, 'models', 'Conversation.js')), {
  find: async () => [],
});

let rescrapeCalls = 0;
let releaseRescrape = null;
// Held open only where a test needs a crawl in flight; everywhere else the stub
// returns at once, so a predicate that wrongly reports an entity due fails on an
// assertion rather than hanging the suite on a crawl nobody is going to release.
let holdCrawl = false;
stubModule(require.resolve(path.join(srcDir, 'services', 'scraper.js')), {
  rescrapeSite: async () => {
    rescrapeCalls++;
    if (holdCrawl) await new Promise((resolve) => { releaseRescrape = resolve; });
    return { changedUrls: [], unchangedUrls: [], skippedUrls: [], durationMs: 1 };
  },
});
stubModule(require.resolve(path.join(srcDir, 'services', 'scrapePersist.js')), {
  persistRescrapeResult: async () => ({
    pagesChanged: 0,
    chunksUpdated: 0,
    failedUrls: [],
    robotsDisallowed: [],
  }),
});

const {
  isDueNow,
  refreshDecision,
  effectiveSchedule,
  runHourlyTick,
  DAILY_MIN_GAP_MS,
  WEEKLY_MIN_GAP_MS,
  DAILY_CATCHUP_MS,
  WEEKLY_CATCHUP_MS,
} = require('../src/services/leoRefresh');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// 2026-08-10T03:00:00Z — 03:00 UTC is the Entity model's default refresh hour.
const AT_SLOT = Date.parse('2026-08-10T03:00:00Z');
const OFF_SLOT = Date.parse('2026-08-10T11:00:00Z');

// The default fixture carries a leoRefreshSubscriptionId because 'daily' is only
// honoured for a subscribed entity (LEO-134) — without one the cap would hold
// every "daily" case below to the weekly windows, which is its own section.
function entity(overrides = {}) {
  return {
    domain: 'example.com',
    leoRefreshEnabled: true,
    leoRefreshHour: 3,
    leoRefreshFrequency: 'daily',
    leoRefreshSubscriptionId: 'sub_leorefresh_test',
    leoRefreshLastRun: null,
    ...overrides,
  };
}

// Enabled by a superadmin rather than bought: no subscription id at all.
function comped(overrides = {}) {
  const e = entity(overrides);
  delete e.leoRefreshSubscriptionId;
  return e;
}

// --- the windows are the ones the item specified -----------------------------

test('windows: daily gap 20h / catch-up 26h, weekly gap 6d / catch-up 8d', () => {
  assert.equal(DAILY_MIN_GAP_MS, 20 * HOUR);
  assert.equal(DAILY_CATCHUP_MS, 26 * HOUR);
  assert.equal(WEEKLY_MIN_GAP_MS, 6 * DAY);
  assert.equal(WEEKLY_CATCHUP_MS, 8 * DAY);
  // The catch-up window must sit PAST the gap guard, or a catch-up could fire
  // on the heels of a real run.
  assert.ok(DAILY_CATCHUP_MS > DAILY_MIN_GAP_MS);
  assert.ok(WEEKLY_CATCHUP_MS > WEEKLY_MIN_GAP_MS);
});

// --- gates -------------------------------------------------------------------

test('disabled: never due, even at its own hour', () => {
  const e = entity({ leoRefreshEnabled: false, leoRefreshLastRun: new Date(AT_SLOT - 10 * DAY) });
  assert.equal(isDueNow(e, AT_SLOT), false);
  assert.equal(refreshDecision(e, AT_SLOT).reason, 'disabled');
});

test('missing entity: never due', () => {
  assert.equal(isDueNow(undefined, AT_SLOT), false);
});

// --- daily -------------------------------------------------------------------

test('daily: due at the scheduled hour, never refreshed before', () => {
  assert.equal(isDueNow(entity(), AT_SLOT), true);
  assert.equal(refreshDecision(entity(), AT_SLOT).reason, 'first-run');
});

test('daily: no leoRefreshLastRun field at all, at the scheduled hour, due', () => {
  const e = entity();
  delete e.leoRefreshLastRun;
  assert.equal(isDueNow(e, AT_SLOT), true);
});

test('daily: wrong hour, not due', () => {
  assert.equal(isDueNow(entity(), OFF_SLOT), false);
  assert.equal(refreshDecision(entity(), OFF_SLOT).reason, 'awaiting-first-slot');
});

test('daily: never refreshed is never caught up — switching LeoRefresh on does not crawl immediately', () => {
  // The unbounded "elapsed" of a null stamp must not read as a missed slot.
  assert.equal(isDueNow(entity(), OFF_SLOT), false);
  assert.equal(isDueNow(entity({ leoRefreshLastRun: undefined }), OFF_SLOT), false);
});

test('daily: at the scheduled hour, last run 23h ago, due (the normal cadence still works)', () => {
  const e = entity({ leoRefreshLastRun: new Date(AT_SLOT - 23 * HOUR) });
  assert.equal(isDueNow(e, AT_SLOT), true);
  assert.equal(refreshDecision(e, AT_SLOT).reason, 'hour-match');
});

test('daily: at the scheduled hour, last run 1h ago, NOT due (gap guard)', () => {
  const e = entity({ leoRefreshLastRun: new Date(AT_SLOT - 1 * HOUR) });
  assert.equal(isDueNow(e, AT_SLOT), false);
  assert.equal(refreshDecision(e, AT_SLOT).reason, 'gap-guard');
});

test('daily: wrong hour, last run 30h ago, due (catch-up after a missed slot)', () => {
  const e = entity({ leoRefreshLastRun: new Date(OFF_SLOT - 30 * HOUR) });
  assert.equal(isDueNow(e, OFF_SLOT), true);
  const d = refreshDecision(e, OFF_SLOT);
  assert.equal(d.reason, 'catch-up');
  assert.match(d.detail, /30h/);
});

test('daily: wrong hour, last run 26h ago exactly, due (window boundary is inclusive)', () => {
  const e = entity({ leoRefreshLastRun: new Date(OFF_SLOT - DAILY_CATCHUP_MS) });
  assert.equal(isDueNow(e, OFF_SLOT), true);
});

test('daily: wrong hour, last run 25h ago, NOT due (inside the catch-up window)', () => {
  const e = entity({ leoRefreshLastRun: new Date(OFF_SLOT - 25 * HOUR) });
  assert.equal(isDueNow(e, OFF_SLOT), false);
  assert.equal(refreshDecision(e, OFF_SLOT).reason, 'off-schedule');
});

test('daily: a caught-up run cannot be followed by a second one in the same day', () => {
  // Caught up at 11:00; every hour until the 20h gap guard clears is held.
  const caughtUp = new Date(OFF_SLOT);
  const e = entity({ leoRefreshLastRun: caughtUp });
  for (let h = 1; h <= 19; h++) {
    assert.equal(isDueNow(e, OFF_SLOT + h * HOUR), false, `h+${h} must be held`);
  }
  // Including the entity's own 03:00 slot, 16h later.
  assert.equal(isDueNow(e, OFF_SLOT + 16 * HOUR), false);
  assert.equal(new Date(OFF_SLOT + 16 * HOUR).getUTCHours(), 3);
});

// --- weekly ------------------------------------------------------------------

test('weekly: at the scheduled hour, last run 7d ago, due', () => {
  const e = entity({ leoRefreshFrequency: 'weekly', leoRefreshLastRun: new Date(AT_SLOT - 7 * DAY) });
  assert.equal(isDueNow(e, AT_SLOT), true);
  assert.equal(refreshDecision(e, AT_SLOT).reason, 'hour-match');
});

test('weekly: last run 3d ago, NOT due at any hour (gap guard)', () => {
  const e = entity({ leoRefreshFrequency: 'weekly', leoRefreshLastRun: new Date(AT_SLOT - 3 * DAY) });
  assert.equal(isDueNow(e, AT_SLOT), false);
  assert.equal(refreshDecision(e, AT_SLOT).reason, 'gap-guard');
  assert.equal(isDueNow(e, OFF_SLOT), false);
});

test('weekly: wrong hour, last run 8d ago, due (catch-up)', () => {
  const e = entity({ leoRefreshFrequency: 'weekly', leoRefreshLastRun: new Date(OFF_SLOT - 8 * DAY) });
  assert.equal(isDueNow(e, OFF_SLOT), true);
  assert.equal(refreshDecision(e, OFF_SLOT).reason, 'catch-up');
});

test('weekly: wrong hour, last run 7d ago, NOT due (inside the 8d catch-up window)', () => {
  const e = entity({ leoRefreshFrequency: 'weekly', leoRefreshLastRun: new Date(OFF_SLOT - 7 * DAY) });
  assert.equal(isDueNow(e, OFF_SLOT), false);
  assert.equal(refreshDecision(e, OFF_SLOT).reason, 'off-schedule');
});

// --- the weekly default and the comped cap (LEO-134) -------------------------
//
// Every entity in the database is a site that never agreed to be crawled, so
// the free cadence has to be the gentle one. Two halves: an unset frequency
// must read as weekly rather than daily, and 'daily' without a subscription
// must be held to the weekly windows — stored value untouched.

test('effectiveSchedule: an absent, null or unrecognised frequency reads as weekly', () => {
  for (const frequency of [undefined, null, '', 'monthly', 'DAILY']) {
    const schedule = effectiveSchedule(entity({ leoRefreshFrequency: frequency }));
    assert.equal(schedule.frequency, 'weekly', `${String(frequency)} must read as weekly`);
    assert.equal(schedule.capped, false, 'a weekly entity is not capped — it asked for weekly');
  }
  const absent = entity();
  delete absent.leoRefreshFrequency;
  assert.equal(effectiveSchedule(absent).frequency, 'weekly');
});

test('effectiveSchedule: daily is honoured with a subscription, capped without one', () => {
  const subscribed = effectiveSchedule(entity({ leoRefreshFrequency: 'daily' }));
  assert.deepEqual(subscribed, { requested: 'daily', frequency: 'daily', capped: false, comped: false });

  const free = effectiveSchedule(comped({ leoRefreshFrequency: 'daily' }));
  assert.deepEqual(free, { requested: 'daily', frequency: 'weekly', capped: true, comped: true });

  // An empty-string subscription id is no subscription.
  assert.equal(effectiveSchedule(comped({ leoRefreshSubscriptionId: '' })).comped, true);
  // And nothing at all is not a crash.
  assert.equal(effectiveSchedule(undefined).frequency, 'weekly');
});

test('comped + daily: held to the weekly gap at its own scheduled hour', () => {
  const e = comped({ leoRefreshLastRun: new Date(AT_SLOT - 23 * HOUR) });
  // The same entity WITH a subscription is due here — that is the control.
  assert.equal(isDueNow(entity({ leoRefreshLastRun: new Date(AT_SLOT - 23 * HOUR) }), AT_SLOT), true);

  assert.equal(isDueNow(e, AT_SLOT), false, 'a comped daily entity must not refresh after 23h');
  const d = refreshDecision(e, AT_SLOT);
  assert.equal(d.reason, 'gap-guard');
  assert.equal(d.capped, true);
  assert.equal(d.frequency, 'weekly');
  assert.equal(d.requestedFrequency, 'daily');
  assert.match(d.detail, /weekly gap guard/);
  assert.match(d.detail, /no LeoRefresh subscription/, 'the held line must name the source of the cap');
});

test('comped + daily: still refreshes on the weekly cadence, not never', () => {
  const e = comped({ leoRefreshLastRun: new Date(AT_SLOT - 7 * DAY) });
  assert.equal(isDueNow(e, AT_SLOT), true);
  assert.equal(refreshDecision(e, AT_SLOT).reason, 'hour-match');

  // And off-hour catch-up uses the weekly window, not the 26h daily one.
  assert.equal(isDueNow(comped({ leoRefreshLastRun: new Date(OFF_SLOT - 30 * HOUR) }), OFF_SLOT), false);
  assert.equal(isDueNow(comped({ leoRefreshLastRun: new Date(OFF_SLOT - 8 * DAY) }), OFF_SLOT), true);
});

test('comped + daily: every hour inside the weekly gap guard is held', () => {
  // The guard is 6d, deliberately under the 7d period, so the hour BEFORE it
  // clears is the last held one — including the entity's own 03:00 slot on each
  // of the five intervening days, which a daily schedule would have taken.
  const e = comped({ leoRefreshLastRun: new Date(AT_SLOT) });
  for (let h = 1; h < 6 * 24; h++) {
    assert.equal(isDueNow(e, AT_SLOT + h * HOUR), false, `h+${h} must be held`);
  }
  assert.equal(isDueNow(e, AT_SLOT + 6 * DAY), true, 'and it refreshes once the weekly gap clears');
});

test('comped, no frequency stored: the weekly windows apply with no cap flag', () => {
  const e = comped({ leoRefreshLastRun: new Date(AT_SLOT - 23 * HOUR) });
  delete e.leoRefreshFrequency;
  assert.equal(isDueNow(e, AT_SLOT), false);
  const d = refreshDecision(e, AT_SLOT);
  assert.equal(d.frequency, 'weekly');
  assert.equal(d.capped, false, 'nothing was overridden — weekly is simply the default');
  assert.equal(isDueNow(comped({ leoRefreshLastRun: new Date(AT_SLOT - 7 * DAY), leoRefreshFrequency: undefined }), AT_SLOT), true);
});

test('comped + weekly: no cap flag, and a disabled comped entity is still just disabled', () => {
  const weeklyFree = comped({ leoRefreshFrequency: 'weekly', leoRefreshLastRun: new Date(AT_SLOT - 7 * DAY) });
  assert.equal(isDueNow(weeklyFree, AT_SLOT), true);
  assert.equal(refreshDecision(weeklyFree, AT_SLOT).capped, false);

  const off = comped({ leoRefreshEnabled: false, leoRefreshLastRun: new Date(AT_SLOT - 10 * DAY) });
  assert.equal(refreshDecision(off, AT_SLOT).reason, 'disabled');
  // The cap is reported even on the disabled arm — the fields come from the
  // schedule, not from the due calculation.
  assert.equal(refreshDecision(off, AT_SLOT).frequency, 'weekly');
});

// --- junk inputs -------------------------------------------------------------

test('unreadable last-run stamp reads as never refreshed, not as an unreachable window', () => {
  const e = entity({ leoRefreshLastRun: 'not a date' });
  assert.equal(isDueNow(e, AT_SLOT), true);
  assert.equal(isDueNow(e, OFF_SLOT), false);
});

test('out-of-range leoRefreshHour falls back to the model default (03:00 UTC)', () => {
  const e = entity({ leoRefreshHour: 99 });
  assert.equal(isDueNow(e, AT_SLOT), true);
  assert.equal(isDueNow(e, OFF_SLOT), false);
});

test('a last run stamped in the future holds off rather than risking a double crawl', () => {
  const e = entity({ leoRefreshLastRun: new Date(AT_SLOT + 2 * DAY) });
  assert.equal(isDueNow(e, AT_SLOT), false);
  assert.equal(refreshDecision(e, AT_SLOT).reason, 'future-stamp');
});

// --- re-entrancy -------------------------------------------------------------

function fakeIo() {
  const sink = { emit() {}, except() { return { emit() {} } } };
  return { to: () => sink };
}

test('two overlapping ticks start exactly one crawl, and the second says why it skipped', async () => {
  rescrapeCalls = 0;
  releaseRescrape = null;
  holdCrawl = true;
  stampedDomains = [];
  enabledEntities = [entity({ domain: 'overlap.example.com' })];

  const lines = [];
  const realLog = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };

  let first;
  let second;
  try {
    first = runHourlyTick(fakeIo(), AT_SLOT);
    // Let the first tick reach the held-open crawl before firing the next hour.
    while (rescrapeCalls === 0) await new Promise((r) => setImmediate(r));

    second = await runHourlyTick(fakeIo(), AT_SLOT + HOUR);
    assert.equal(rescrapeCalls, 1, 'the second tick must not start a second crawl');

    releaseRescrape();
    const firstResult = await first;
    assert.equal(firstResult.ran, true);
    assert.equal(firstResult.due, 1);
  } finally {
    console.log = realLog;
    holdCrawl = false;
    if (releaseRescrape) releaseRescrape();
    await first;
  }

  assert.equal(second.ran, false);
  assert.equal(second.reason, 'in-flight');
  assert.equal(rescrapeCalls, 1);
  assert.deepEqual(stampedDomains, ['overlap.example.com']);
  assert.ok(
    lines.some((l) => l.includes('re-entrancy') && l.includes('still running')),
    `expected a re-entrancy line, got:\n${lines.join('\n')}`
  );
});

test('the flag is released, so the next tick after a crawl finishes runs normally', async () => {
  rescrapeCalls = 0;
  releaseRescrape = null;
  holdCrawl = true;
  stampedDomains = [];
  enabledEntities = [entity({ domain: 'again.example.com' })];

  const run = runHourlyTick(fakeIo(), AT_SLOT);
  while (rescrapeCalls === 0) await new Promise((r) => setImmediate(r));
  releaseRescrape();
  await run;

  // A day later, at its slot again: the guard must not be stuck on.
  const next = runHourlyTick(fakeIo(), AT_SLOT + DAY);
  while (rescrapeCalls < 2) await new Promise((r) => setImmediate(r));
  releaseRescrape();
  const result = await next;
  holdCrawl = false;
  assert.equal(result.ran, true);
  assert.equal(rescrapeCalls, 2);
});

test('the light tier names the cap as the source when a comped daily entity is held', async () => {
  rescrapeCalls = 0;
  holdCrawl = false;
  enabledEntities = [comped({ domain: 'capped.example.com', leoRefreshLastRun: new Date(AT_SLOT - HOUR) })];

  const lines = [];
  const realLog = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    await runHourlyTick(fakeIo(), AT_SLOT);
  } finally {
    console.log = realLog;
  }

  assert.equal(rescrapeCalls, 0, 'a held entity must not be crawled');
  assert.ok(
    lines.some((l) => l.includes('held to weekly') && l.includes('no leoRefreshSubscriptionId')),
    `expected a cap line naming its source, got:\n${lines.join('\n')}`
  );
});

test('a tick with nothing due neither crawls nor leaves the flag raised', async () => {
  rescrapeCalls = 0;
  holdCrawl = false;
  enabledEntities = [entity({ domain: 'quiet.example.com', leoRefreshLastRun: new Date(AT_SLOT - HOUR) })];
  const result = await runHourlyTick(fakeIo(), AT_SLOT);
  assert.equal(result.reason, 'none-due');
  assert.equal(rescrapeCalls, 0);
  const again = await runHourlyTick(fakeIo(), AT_SLOT);
  assert.equal(again.reason, 'none-due');
});
