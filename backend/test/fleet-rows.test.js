// Fleet overview row assembly (LEO-009).
//
// buildFleetRows is pure and synchronous, so these tests run on plain fixtures —
// no DB, no HTTP. The last test enforces the property that actually matters in
// production by reading the source: no `await` inside a loop anywhere on the
// /fleet path. The endpoint must stay one find + two aggregates however many
// entities exist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildFleetRows, FREE_TIER_LIMIT, STALE_DAYS } = require('../src/services/fleet');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-12T00:00:00Z').getTime();

test('entity with zero chunks and zero conversations gets zero counts, not missing fields', () => {
  const entities = [{ domain: 'empty.example.com', name: 'Empty', plan: 'free' }];
  const rows = buildFleetRows(entities, [], [], NOW);

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.chunkCount, 0);
  assert.equal(row.conversationCount, 0);
  assert.equal(row.totalMessages, 0);
  assert.equal(row.lastVisitorActiveAt, null);
  assert.equal(row.messageCountThisPeriod, 0);
  assert.equal(row.quotaLimit, FREE_TIER_LIMIT);
  assert.equal(row.quotaStatus, 'ok');
  assert.equal(row.crawlStale, true, 'never-scraped entity must read as stale');
  assert.equal(row.lastScrapedAt, null);
});

test('aggregate groups are joined by domain; unmatched groups are ignored', () => {
  const entities = [
    { domain: 'a.example.com', name: 'A', plan: 'free' },
    { domain: 'b.example.com', name: 'B', plan: 'free' },
  ];
  const chunkGroups = [
    { _id: 'a.example.com', chunkCount: 19 },
    { _id: 'ghost.example.com', chunkCount: 7 }, // no matching entity — dropped
  ];
  const lastActive = new Date('2026-08-11T12:00:00Z');
  const conversationGroups = [
    { _id: 'a.example.com', conversationCount: 3, totalMessages: 42, lastActiveAt: lastActive },
  ];

  const rows = buildFleetRows(entities, chunkGroups, conversationGroups, NOW);
  const a = rows.find((r) => r.domain === 'a.example.com');
  const b = rows.find((r) => r.domain === 'b.example.com');

  assert.equal(a.chunkCount, 19);
  assert.equal(a.conversationCount, 3);
  assert.equal(a.totalMessages, 42);
  assert.equal(a.lastVisitorActiveAt, lastActive);
  assert.equal(b.chunkCount, 0);
  assert.equal(b.conversationCount, 0);
  assert.equal(rows.length, 2, 'ghost aggregate group must not create a row');
});

test('quota status: free plan maps ok / near / over; capless plans have null status', () => {
  const entities = [
    { domain: 'ok.example.com', name: 'Ok', plan: 'free', messageCountThisPeriod: 74 },
    { domain: 'near.example.com', name: 'Near', plan: 'free', messageCountThisPeriod: 75 },
    { domain: 'over.example.com', name: 'Over', plan: 'free', messageCountThisPeriod: 100 },
    { domain: 'inf.example.com', name: 'Inf', plan: 'infinity', messageCountThisPeriod: 5000 },
    { domain: 'life.example.com', name: 'Life', plan: 'lifetime', messageCountThisPeriod: 0 },
    { domain: 'default.example.com', name: 'Default', messageCountThisPeriod: 99 }, // missing plan = free
  ];
  const byDomain = Object.fromEntries(
    buildFleetRows(entities, [], [], NOW).map((r) => [r.domain, r])
  );

  assert.equal(byDomain['ok.example.com'].quotaStatus, 'ok');
  assert.equal(byDomain['near.example.com'].quotaStatus, 'near');
  assert.equal(byDomain['over.example.com'].quotaStatus, 'over');
  assert.equal(byDomain['inf.example.com'].quotaStatus, null);
  assert.equal(byDomain['inf.example.com'].quotaLimit, null);
  assert.equal(byDomain['life.example.com'].quotaStatus, null);
  assert.equal(byDomain['default.example.com'].plan, 'free');
  assert.equal(byDomain['default.example.com'].quotaStatus, 'near');
});

test('crawl staleness: fresh under the threshold, stale past it or when unparseable', () => {
  const entities = [
    { domain: 'fresh.example.com', name: 'F', lastScrapedAt: new Date(NOW - (STALE_DAYS - 1) * DAY) },
    { domain: 'stale.example.com', name: 'S', lastScrapedAt: new Date(NOW - (STALE_DAYS + 1) * DAY) },
    { domain: 'garbage.example.com', name: 'G', lastScrapedAt: 'not-a-date' },
  ];
  const byDomain = Object.fromEntries(
    buildFleetRows(entities, [], [], NOW).map((r) => [r.domain, r])
  );

  assert.equal(byDomain['fresh.example.com'].crawlStale, false);
  assert.equal(byDomain['stale.example.com'].crawlStale, true);
  assert.equal(byDomain['garbage.example.com'].crawlStale, true);
});

// ---------------------------------------------------------------------------
// Source-level assertion: no `await` inside a loop on the /fleet path.
// ---------------------------------------------------------------------------

// Comments may talk about the rule without breaking it — assert on code only.
function stripLineComments(src) {
  return src.replace(/\/\/[^\n]*/g, '');
}

test('fleet source: service is fully synchronous, route handler has no loops', () => {
  const serviceSrc = stripLineComments(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'fleet.js'), 'utf8')
  );
  assert.ok(!/\bawait\b/.test(serviceSrc), 'services/fleet.js must contain no await at all');

  const adminSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'admin.js'),
    'utf8'
  );
  const start = adminSrc.indexOf("router.get('/fleet'");
  assert.ok(start !== -1, '/fleet route must exist in routes/admin.js');
  const end = adminSrc.indexOf('router.', start + 1);
  const handler = adminSrc.slice(start, end === -1 ? undefined : end);

  assert.ok(
    !/\bfor\s*\(|\bwhile\s*\(|\.forEach\s*\(|\.map\s*\(\s*async/.test(handler),
    '/fleet handler must not loop — one find + two aggregates, whatever the entity count'
  );
  const aggregateCalls = (handler.match(/\.aggregate\(/g) || []).length;
  assert.equal(aggregateCalls, 2, '/fleet must use exactly two grouped aggregates');
  assert.ok(/Promise\.all/.test(handler), 'the two aggregates must run concurrently');
});
