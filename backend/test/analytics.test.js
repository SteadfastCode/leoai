// Owner analytics shaping (LEO-041).
//
// shapeDailyBuckets and shapeTopQuestions are pure — fixtures only, no DB.

const test = require('node:test');
const assert = require('node:assert/strict');

const { shapeDailyBuckets, shapeTopQuestions, dayRange } = require('../src/services/analytics');

const NOW = new Date('2026-08-19T12:00:00Z');

test('empty range → dense zero-filled series of the requested length', () => {
  const out = shapeDailyBuckets({ days: 30, now: NOW });
  assert.equal(out.length, 30);
  assert.equal(out[0].day, '2026-07-21');
  assert.equal(out[29].day, '2026-08-19');
  for (const row of out) {
    assert.deepEqual(
      { conversations: row.conversations, messages: row.messages, unanswered: row.unanswered },
      { conversations: 0, messages: 0, unanswered: 0 }
    );
  }
});

test('sparse days are zero-filled, present days carry their counts', () => {
  const out = shapeDailyBuckets({
    convRows: [{ _id: '2026-08-18', count: 3 }],
    msgRows: [{ _id: '2026-08-18', count: 12 }, { _id: '2026-08-01', count: 5 }],
    unansweredRows: [{ _id: '2026-08-19', count: 2 }],
    days: 30,
    now: NOW,
  });
  const byDay = Object.fromEntries(out.map((r) => [r.day, r]));
  assert.deepEqual(byDay['2026-08-18'], { day: '2026-08-18', conversations: 3, messages: 12, unanswered: 0 });
  assert.deepEqual(byDay['2026-08-01'], { day: '2026-08-01', conversations: 0, messages: 5, unanswered: 0 });
  assert.deepEqual(byDay['2026-08-19'], { day: '2026-08-19', conversations: 0, messages: 0, unanswered: 2 });
  assert.deepEqual(byDay['2026-08-10'], { day: '2026-08-10', conversations: 0, messages: 0, unanswered: 0 });
});

test('rows outside the range are ignored', () => {
  const out = shapeDailyBuckets({
    convRows: [{ _id: '2025-01-01', count: 99 }],
    days: 30,
    now: NOW,
  });
  assert.equal(out.reduce((s, r) => s + r.conversations, 0), 0);
});

test('dayRange spans a month boundary correctly', () => {
  const keys = dayRange(3, new Date('2026-08-01T06:00:00Z'));
  assert.deepEqual(keys, ['2026-07-30', '2026-07-31', '2026-08-01']);
});

test('top questions: similar phrasings group, counts aggregate', () => {
  const qs = [
    { text: 'What are your opening hours?', askedAt: new Date('2026-08-19T10:00:00Z') },
    { text: 'what are your opening hours', askedAt: new Date('2026-08-18T10:00:00Z') },
    { text: 'Do you sell sourdough bread?', askedAt: new Date('2026-08-17T10:00:00Z') },
  ];
  const out = shapeTopQuestions(qs);
  assert.equal(out.length, 2);
  assert.equal(out[0].count, 2);
  assert.equal(out[0].question, 'What are your opening hours?');
  assert.equal(out[1].count, 1);
});

test('ties in count break deterministically by most recent lastAskedAt', () => {
  const older = { text: 'Where can I park my car downtown?', askedAt: new Date('2026-08-10T00:00:00Z') };
  const newer = { text: 'Do you offer gluten free bagels?', askedAt: new Date('2026-08-18T00:00:00Z') };
  // Same input both orders → same output order (newer first)
  const a = shapeTopQuestions([older, newer]);
  const b = shapeTopQuestions([newer, older]);
  assert.deepEqual(a.map((g) => g.question), b.map((g) => g.question));
  assert.equal(a[0].question, newer.text);
  assert.equal(a[0].count, 1);
  assert.equal(a[1].count, 1);
});

test('limit caps the list; blank and malformed entries are dropped', () => {
  const qs = [];
  for (let i = 0; i < 15; i++) qs.push({ text: `unique question number ${i} zzz${i}`, askedAt: NOW });
  qs.push({ text: '   ' }, {}, null);
  const out = shapeTopQuestions(qs, 10);
  assert.equal(out.length, 10);
});

test('empty questions → empty list', () => {
  assert.deepEqual(shapeTopQuestions([]), []);
  assert.deepEqual(shapeTopQuestions(undefined), []);
});
