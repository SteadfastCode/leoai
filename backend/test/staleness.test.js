// Staleness-based force re-embed predicate (LEO-029).
//
// Pure unit test — no DB, no network. `now` is injected so the assertions are
// not clock-dependent.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');

const { isStale, MS_PER_DAY } = require('../src/services/staleness');

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0); // fixed reference instant
const daysAgo = (n) => new Date(NOW - n * MS_PER_DAY);

test('staleDays 0 disables the check entirely', () => {
  // The default. Every existing entity must be unaffected.
  assert.equal(isStale(daysAgo(999), 0, NOW), false);
  assert.equal(isStale(null, 0, NOW), false);
  assert.equal(isStale(undefined, 0, NOW), false);
});

test('a missing or unset staleDays is treated as disabled', () => {
  assert.equal(isStale(daysAgo(999), undefined, NOW), false);
  assert.equal(isStale(daysAgo(999), null, NOW), false);
  assert.equal(isStale(daysAgo(999), '', NOW), false);
  assert.equal(isStale(daysAgo(999), 'not a number', NOW), false);
  assert.equal(isStale(daysAgo(999), -5, NOW), false, 'a negative threshold must not enable it');
});

test('exactly N days old is stale; anything younger is not', () => {
  assert.equal(isStale(daysAgo(7), 7, NOW), true, 'exactly at the boundary counts as stale');
  assert.equal(isStale(new Date(NOW - 7 * MS_PER_DAY + 1000), 7, NOW), false, 'one second short is not');
  assert.equal(isStale(daysAgo(8), 7, NOW), true);
  assert.equal(isStale(daysAgo(6), 7, NOW), false);
});

test('a missing lastScrapedAt is stale', () => {
  // No recorded scrape — refresh rather than assume it is current.
  assert.equal(isStale(null, 7, NOW), true);
  assert.equal(isStale(undefined, 7, NOW), true);
});

test('an unparseable lastScrapedAt is stale rather than trusted', () => {
  assert.equal(isStale('not a date', 7, NOW), true);
});

test('a future lastScrapedAt is not stale', () => {
  // Clock skew, or a row written ahead — must not trigger an endless re-embed.
  assert.equal(isStale(new Date(NOW + 5 * MS_PER_DAY), 7, NOW), false);
  assert.equal(isStale(new Date(NOW + 1000), 1, NOW), false);
});

test('accepts both Date objects and ISO strings', () => {
  assert.equal(isStale(daysAgo(10).toISOString(), 7, NOW), true);
  assert.equal(isStale(daysAgo(3).toISOString(), 7, NOW), false);
});

test('a fractional threshold works (sub-day windows)', () => {
  assert.equal(isStale(new Date(NOW - 13 * 60 * 60 * 1000), 0.5, NOW), true);
  assert.equal(isStale(new Date(NOW - 11 * 60 * 60 * 1000), 0.5, NOW), false);
});
