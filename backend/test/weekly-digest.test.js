// Weekly owner-digest contracts (LEO-042): the pure due-date calculation
// (including DST-adjacent weekends, which must not move a UTC schedule), the
// conversation fold, and the body renderer's zero-activity suppression and
// ordering.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  weeklyDigestDue,
  summarizeConversations,
  renderWeeklyDigestBody,
  WEEKLY_MIN_GAP_MS,
} = require('../src/services/weeklyDigest');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function entity(overrides = {}, cfg = {}) {
  return {
    domain: 'example.com',
    name: 'Example Bakery',
    ownerEmail: 'owner@example.com',
    weeklyDigest: { enabled: true, hourUtc: 14, dayOfWeek: 1, ...cfg },
    lastWeeklyDigestAt: null,
    ...overrides,
  };
}

// 2026-08-10 is a Monday.
const MONDAY_14 = Date.parse('2026-08-10T14:00:00Z');

// --- weeklyDigestDue: gates -------------------------------------------------

test('disabled: never due', () => {
  assert.equal(weeklyDigestDue(entity({}, { enabled: false }), MONDAY_14), false);
});

test('missing config object: never due', () => {
  assert.equal(weeklyDigestDue(entity({ weeklyDigest: undefined }), MONDAY_14), false);
});

test('no ownerEmail: never due — nowhere to send it', () => {
  assert.equal(weeklyDigestDue(entity({ ownerEmail: '' }), MONDAY_14), false);
});

test('enabled, on schedule, never sent: due', () => {
  assert.equal(weeklyDigestDue(entity(), MONDAY_14), true);
});

test('wrong UTC hour: not due', () => {
  assert.equal(weeklyDigestDue(entity(), MONDAY_14 + HOUR), false);
});

test('wrong UTC weekday: not due', () => {
  assert.equal(weeklyDigestDue(entity(), MONDAY_14 + DAY), false);
});

test('defaults apply when hourUtc/dayOfWeek are absent (Monday 14:00 UTC)', () => {
  const e = entity({}, { hourUtc: undefined, dayOfWeek: undefined });
  assert.equal(weeklyDigestDue(e, MONDAY_14), true);
  assert.equal(weeklyDigestDue(e, MONDAY_14 + HOUR), false);
});

test('Sunday schedule (dayOfWeek 0) matches Sunday, not Monday', () => {
  const e = entity({}, { dayOfWeek: 0 });
  assert.equal(weeklyDigestDue(e, Date.parse('2026-08-09T14:00:00Z')), true);
  assert.equal(weeklyDigestDue(e, MONDAY_14), false);
});

// --- weeklyDigestDue: elapsed-time guard ------------------------------------

test('sent one hour ago: not due — the guard blocks a same-hour second fire', () => {
  assert.equal(
    weeklyDigestDue(entity({ lastWeeklyDigestAt: new Date(MONDAY_14 - HOUR) }), MONDAY_14),
    false
  );
});

test('sent a full week ago: due again', () => {
  assert.equal(
    weeklyDigestDue(entity({ lastWeeklyDigestAt: new Date(MONDAY_14 - 7 * DAY) }), MONDAY_14),
    true
  );
});

test('guard boundary: exactly WEEKLY_MIN_GAP_MS ago is due, one ms short is not', () => {
  assert.equal(
    weeklyDigestDue(entity({ lastWeeklyDigestAt: new Date(MONDAY_14 - WEEKLY_MIN_GAP_MS) }), MONDAY_14),
    true
  );
  assert.equal(
    weeklyDigestDue(entity({ lastWeeklyDigestAt: new Date(MONDAY_14 - WEEKLY_MIN_GAP_MS + 1) }), MONDAY_14),
    false
  );
});

test('lastWeeklyDigestAt accepted as an ISO string, not just a Date', () => {
  assert.equal(
    weeklyDigestDue(entity({ lastWeeklyDigestAt: new Date(MONDAY_14 - 7 * DAY).toISOString() }), MONDAY_14),
    true
  );
});

// --- DST-adjacent -----------------------------------------------------------
// The schedule is UTC end to end, so a civil DST transition must not shift the
// send hour and must not let two sends land in one week. These weekends are
// where a local-time implementation would break.

test('US DST ends 2026-11-01: the Monday after still fires at 14:00 UTC exactly', () => {
  // 2026-11-02 is the Monday after the US fall-back weekend.
  const monday = Date.parse('2026-11-02T14:00:00Z');
  const e = entity({ lastWeeklyDigestAt: new Date(Date.parse('2026-10-26T14:00:00Z')) });
  assert.equal(weeklyDigestDue(e, monday), true);
  // The neighbouring UTC hours must not also match — a local-time bug shows up
  // here as a second true.
  assert.equal(weeklyDigestDue(e, monday - HOUR), false);
  assert.equal(weeklyDigestDue(e, monday + HOUR), false);
});

test('US DST begins 2026-03-08: the Monday after still fires at 14:00 UTC exactly', () => {
  const monday = Date.parse('2026-03-09T14:00:00Z');
  const e = entity({ lastWeeklyDigestAt: new Date(Date.parse('2026-03-02T14:00:00Z')) });
  assert.equal(weeklyDigestDue(e, monday), true);
  assert.equal(weeklyDigestDue(e, monday - HOUR), false);
  assert.equal(weeklyDigestDue(e, monday + HOUR), false);
});

test('EU DST ends 2026-10-25 (Sunday): a Sunday schedule fires once, not twice', () => {
  const e = entity({}, { dayOfWeek: 0 });
  const sunday = Date.parse('2026-10-25T14:00:00Z');
  assert.equal(weeklyDigestDue(e, sunday), true);
  // After stamping, no other hour of that 25-hour civil day may fire.
  const sent = entity({ lastWeeklyDigestAt: new Date(sunday) }, { dayOfWeek: 0 });
  for (let h = 1; h <= 12; h++) {
    assert.equal(weeklyDigestDue(sent, sunday + h * HOUR), false, `hour +${h} double-fired`);
  }
});

// --- summarizeConversations -------------------------------------------------

const SINCE = Date.parse('2026-08-03T14:00:00Z');
const IN = new Date(Date.parse('2026-08-05T09:00:00Z'));
const OUT = new Date(Date.parse('2026-07-20T09:00:00Z'));

test('counts assistant messages, collects user questions, ignores owner replies', () => {
  const { messages, questions } = summarizeConversations(
    [
      {
        messages: [
          { role: 'user', content: 'Are you open Sunday?', timestamp: IN },
          { role: 'assistant', content: 'We are!', timestamp: IN },
          { role: 'owner_reply', content: 'Thanks for waiting', timestamp: IN },
        ],
      },
    ],
    SINCE
  );
  assert.equal(messages, 1);
  assert.deepEqual(questions.map((q) => q.text), ['Are you open Sunday?']);
});

test('messages older than the window are excluded', () => {
  const { messages, questions } = summarizeConversations(
    [
      {
        messages: [
          { role: 'assistant', content: 'old', timestamp: OUT },
          { role: 'user', content: 'old question', timestamp: OUT },
          { role: 'assistant', content: 'new', timestamp: IN },
        ],
      },
    ],
    SINCE
  );
  assert.equal(messages, 1);
  assert.equal(questions.length, 0);
});

test('handoff counted only when escalated inside the window', () => {
  const convos = [
    { messages: [], lastHandoffNotifiedAt: IN },
    { messages: [], lastHandoffNotifiedAt: OUT },
    { messages: [] },
  ];
  assert.equal(summarizeConversations(convos, SINCE).handoffs, 1);
});

test('empty and missing input folds to zeroes without throwing', () => {
  assert.deepEqual(summarizeConversations([], SINCE), { messages: 0, handoffs: 0, questions: [] });
  assert.deepEqual(summarizeConversations(undefined, SINCE), { messages: 0, handoffs: 0, questions: [] });
  assert.deepEqual(summarizeConversations([{}], SINCE), { messages: 0, handoffs: 0, questions: [] });
});

// --- renderWeeklyDigestBody: zero-activity suppression -----------------------

test('zero activity: renders null so no email is sent', () => {
  assert.equal(renderWeeklyDigestBody('Example Bakery', { messages: 0, handoffs: 0, unanswered: 0, topQuestions: [] }), null);
});

test('missing stats object entirely: renders null', () => {
  assert.equal(renderWeeklyDigestBody('Example Bakery'), null);
});

test('any single non-zero signal is enough to render', () => {
  assert.notEqual(renderWeeklyDigestBody('B', { messages: 1 }), null);
  assert.notEqual(renderWeeklyDigestBody('B', { handoffs: 1 }), null);
  assert.notEqual(renderWeeklyDigestBody('B', { unanswered: 1 }), null);
  assert.notEqual(renderWeeklyDigestBody('B', { topQuestions: [{ question: 'q', count: 1 }] }), null);
});

// --- renderWeeklyDigestBody: content and ordering ---------------------------

test('counter lines are omitted when zero, pluralised when not', () => {
  const body = renderWeeklyDigestBody('Example Bakery', { messages: 1, handoffs: 0, unanswered: 2 });
  assert.match(body, /1 message answered/);
  assert.match(body, /2 questions Leo couldn't answer/);
  assert.doesNotMatch(body, /passed to you/);
});

test('top questions are ordered most-asked first regardless of input order', () => {
  const body = renderWeeklyDigestBody('Example Bakery', {
    messages: 10,
    topQuestions: [
      { question: 'Do you deliver?', count: 2, lastAskedAt: IN },
      { question: 'What are your hours?', count: 9, lastAskedAt: IN },
      { question: 'Gluten free?', count: 5, lastAskedAt: IN },
    ],
  });
  const order = body.split('\n').filter((l) => l.includes('×')).map((l) => l.trim());
  assert.deepEqual(order, ['9×  What are your hours?', '5×  Gluten free?', '2×  Do you deliver?']);
});

test('equal counts are tie-broken by most recently asked', () => {
  const older = new Date(Date.parse('2026-08-04T09:00:00Z'));
  const newer = new Date(Date.parse('2026-08-06T09:00:00Z'));
  const body = renderWeeklyDigestBody('B', {
    messages: 4,
    topQuestions: [
      { question: 'older', count: 3, lastAskedAt: older },
      { question: 'newer', count: 3, lastAskedAt: newer },
    ],
  });
  assert.ok(body.indexOf('newer') < body.indexOf('older'));
});

test('at most five questions are listed', () => {
  const body = renderWeeklyDigestBody('B', {
    messages: 20,
    topQuestions: Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, count: 9 - i, lastAskedAt: IN })),
  });
  assert.equal(body.split('\n').filter((l) => l.includes('×')).length, 5);
});

test('body names the entity and links the dashboard', () => {
  const body = renderWeeklyDigestBody('Example Bakery', { messages: 3 });
  assert.match(body, /Example Bakery/);
  assert.match(body, /https:\/\/leo-ai\.app\/#\/overview/);
  assert.match(body, /— Leo$/);
});

test('rendering does not mutate the caller\'s topQuestions array', () => {
  const input = [
    { question: 'a', count: 1, lastAskedAt: IN },
    { question: 'b', count: 7, lastAskedAt: IN },
  ];
  renderWeeklyDigestBody('B', { messages: 1, topQuestions: input });
  assert.deepEqual(input.map((q) => q.question), ['a', 'b']);
});
