// Unanswered-digest contracts (LEO-026): the pure due-date calculation
// (weekly and daily, DST-adjacent), the body renderer's empty-list
// suppression, and the shared grouping the digest reuses from questions.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { digestDue, renderDigestBody } = require('../src/services/unansweredDigest');
const { groupQuestions } = require('../src/services/questions');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function entity(overrides = {}, cfg = {}) {
  return {
    domain: 'example.com',
    name: 'Example Bakery',
    ownerEmail: 'owner@example.com',
    unansweredDigest: { enabled: true, frequency: 'weekly', hourUtc: 13, dayOfWeek: 1, ...cfg },
    unansweredDigestLastSentAt: null,
    ...overrides,
  };
}

// 2026-08-10 is a Monday.
const MONDAY_13 = Date.parse('2026-08-10T13:00:00Z');

// --- digestDue: gates -------------------------------------------------------

test('disabled: never due', () => {
  assert.equal(digestDue(entity({}, { enabled: false }), MONDAY_13), false);
});

test('missing config object: never due', () => {
  assert.equal(digestDue(entity({ unansweredDigest: undefined }), MONDAY_13), false);
});

test('no ownerEmail: never due', () => {
  assert.equal(digestDue(entity({ ownerEmail: '' }), MONDAY_13), false);
});

// --- digestDue: weekly ------------------------------------------------------

test('weekly: due at the configured UTC hour and weekday, never sent before', () => {
  assert.equal(digestDue(entity(), MONDAY_13), true);
});

test('weekly: wrong hour, not due', () => {
  assert.equal(digestDue(entity(), MONDAY_13 + HOUR), false);
});

test('weekly: wrong weekday, not due', () => {
  assert.equal(digestDue(entity(), MONDAY_13 + DAY), false);
});

test('weekly: sent 7 days ago, due again', () => {
  assert.equal(digestDue(entity({ unansweredDigestLastSentAt: new Date(MONDAY_13 - 7 * DAY) }), MONDAY_13), true);
});

test('weekly: stamped moments ago (replayed fire in the same hour), not due', () => {
  assert.equal(digestDue(entity({ unansweredDigestLastSentAt: new Date(MONDAY_13 - 5 * 60 * 1000) }), MONDAY_13 + 30 * 60 * 1000), false);
});

// --- digestDue: daily -------------------------------------------------------

test('daily: due at the configured hour regardless of weekday', () => {
  const e = entity({}, { frequency: 'daily' });
  assert.equal(digestDue(e, MONDAY_13), true);
  assert.equal(digestDue(e, MONDAY_13 + DAY), true);
});

test('daily: sent 24h ago, due again', () => {
  const e = entity({ unansweredDigestLastSentAt: new Date(MONDAY_13 - DAY) }, { frequency: 'daily' });
  assert.equal(digestDue(e, MONDAY_13), true);
});

test('daily: sent 2h ago, not due even at a schedule match', () => {
  const e = entity({ unansweredDigestLastSentAt: new Date(MONDAY_13 - 2 * HOUR) }, { frequency: 'daily' });
  assert.equal(digestDue(e, MONDAY_13), false);
});

// --- digestDue: DST-adjacent ------------------------------------------------
// The schedule is pure UTC, so a 23- or 25-hour local day must not skip or
// double a send. 2026-03-08 (US spring-forward) and 2026-11-01 (fall-back).

test('DST spring-forward day: daily digest still exactly 24 UTC-hours apart, due once', () => {
  const before = Date.parse('2026-03-07T13:00:00Z');
  const after = Date.parse('2026-03-08T13:00:00Z');
  const e = entity({ unansweredDigestLastSentAt: new Date(before) }, { frequency: 'daily' });
  assert.equal(digestDue(e, after), true);
  // Stamped at 13:00, a replayed fire later in the same UTC hour is inside the gap guard.
  const stamped = entity({ unansweredDigestLastSentAt: new Date(after) }, { frequency: 'daily' });
  assert.equal(digestDue(stamped, after + 30 * 60 * 1000), false);
});

test('DST fall-back week: weekly digest due exactly at the next UTC weekday match', () => {
  // 2026-10-26 and 2026-11-02 are both Mondays, 168 UTC-hours apart.
  const before = Date.parse('2026-10-26T13:00:00Z');
  const after = Date.parse('2026-11-02T13:00:00Z');
  const e = entity({ unansweredDigestLastSentAt: new Date(before) });
  assert.equal(digestDue(e, after), true);
  // The 25-hour local day in between never lines up: wrong weekday.
  assert.equal(digestDue(e, Date.parse('2026-11-01T13:00:00Z')), false);
});

// --- renderDigestBody -------------------------------------------------------

test('empty list: renders null, suppressing the email', () => {
  assert.equal(renderDigestBody('Example Bakery', []), null);
  assert.equal(renderDigestBody('Example Bakery', null), null);
});

test('body lists each group with its count and totals correctly', () => {
  const groups = [
    { question: 'Do you have gluten free bread?', count: 3, lastAskedAt: '2026-08-09T10:00:00Z' },
    { question: 'Can I book a class?', count: 1, lastAskedAt: '2026-08-08T09:00:00Z' },
  ];
  const body = renderDigestBody('Example Bakery', groups);
  assert.match(body, /4 questions/);
  assert.match(body, /3×\s+Do you have gluten free bread\?/);
  assert.match(body, /1×\s+Can I book a class\?/);
  assert.match(body, /last asked 2026-08-09/);
  assert.match(body, /leo-ai\.app/);
});

test('single question uses singular phrasing', () => {
  const body = renderDigestBody('Example Bakery', [
    { question: 'Do you ship?', count: 1, lastAskedAt: '2026-08-09T10:00:00Z' },
  ]);
  assert.match(body, /1 question he/);
});

// --- groupQuestions (shared with the dashboard endpoint) --------------------

test('near-duplicate questions group; most recent is representative; sorted by count', () => {
  const qs = [
    { _id: 'a', question: 'What are your gluten free options?', createdAt: '2026-08-09T12:00:00Z' },
    { _id: 'b', question: 'Do you ship nationwide?', createdAt: '2026-08-09T11:00:00Z' },
    { _id: 'c', question: 'What gluten free options are there?', createdAt: '2026-08-08T10:00:00Z' },
  ];
  const groups = groupQuestions(qs);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].id, 'a'); // newest variant represents the group
  assert.deepEqual(groups[0].allIds.sort(), ['a', 'c']);
  assert.equal(groups[1].count, 1);
});

test('unrelated questions stay separate', () => {
  const qs = [
    { _id: 'a', question: 'What time do you open?', createdAt: '2026-08-09T12:00:00Z' },
    { _id: 'b', question: 'Do you cater weddings?', createdAt: '2026-08-09T11:00:00Z' },
  ];
  assert.equal(groupQuestions(qs).length, 2);
});
