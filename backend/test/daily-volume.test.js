// Daily volume guardrail (LEO-035).
//
// The "should alert now" decision is pure (today's count, threshold, last
// alerted day, clock) — no DB, no Twilio/Resend, nothing to stub, and no send
// path is ever touched. The once-per-day atomicity lives in trackDailyVolume's
// findOneAndUpdate test-and-set (same pattern as the handoff alert) and is not
// exercised here.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldAlertNow, utcDay } = require('../src/services/dailyVolume');

const NOW = new Date('2026-08-19T12:00:00Z');

test('utcDay: formats the UTC calendar date, midnight is a boundary', () => {
  assert.equal(utcDay(NOW), '2026-08-19');
  assert.equal(utcDay(new Date('2026-08-19T23:59:59.999Z')), '2026-08-19');
  assert.equal(utcDay(new Date('2026-08-20T00:00:00.000Z')), '2026-08-20');
});

test('under threshold: no alert', () => {
  assert.equal(shouldAlertNow({ todayCount: 999, threshold: 1000, lastAlertedDay: null, now: NOW }), false);
});

test('at threshold: alerts', () => {
  assert.equal(shouldAlertNow({ todayCount: 1000, threshold: 1000, lastAlertedDay: null, now: NOW }), true);
});

test('over threshold: alerts', () => {
  assert.equal(shouldAlertNow({ todayCount: 1500, threshold: 1000, lastAlertedDay: null, now: NOW }), true);
});

test('disabled (threshold 0): never alerts', () => {
  assert.equal(shouldAlertNow({ todayCount: 99999, threshold: 0, lastAlertedDay: null, now: NOW }), false);
});

test('absent threshold: never alerts', () => {
  assert.equal(shouldAlertNow({ todayCount: 99999, threshold: undefined, lastAlertedDay: null, now: NOW }), false);
  assert.equal(shouldAlertNow({ todayCount: 99999, threshold: null, lastAlertedDay: null, now: NOW }), false);
});

test('already alerted today: no second alert', () => {
  assert.equal(shouldAlertNow({ todayCount: 2000, threshold: 1000, lastAlertedDay: '2026-08-19', now: NOW }), false);
});

test("alerted yesterday: today's crossing alerts again", () => {
  assert.equal(shouldAlertNow({ todayCount: 1200, threshold: 1000, lastAlertedDay: '2026-08-18', now: NOW }), true);
});
