// Weekly "what Leo did" digest contracts (LEO-042): the pure due-date
// calculation (DST-adjacent), the week summariser's activity detection, and
// the body renderer's zero-activity suppression and line ordering.
//
// Nothing here touches the DB or the mailer — the tick's send path is the one
// thing these tests deliberately do not exercise, because triggering a real
// send is the failure mode that matters most.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  weeklyDigestDue,
  summarizeWeek,
  renderWeeklyDigestBody,
  MIN_GAP_MS,
  WEEK_MS,
} = require('../src/services/weeklyDigest');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function entity(overrides = {}, cfg = {}) {
  return {
    domain: 'example.com',
    name: 'Example Bakery',
    ownerEmail: 'owner@example.com',
    weeklyDigest: { enabled: true, dayOfWeek: 1, hour: 13, ...cfg },
    lastWeeklyDigestAt: null,
    ...overrides,
  };
}

// 2026-08-10 is a Monday.
const MONDAY_13 = Date.parse('2026-08-10T13:00:00Z');

// --- weeklyDigestDue: gates -------------------------------------------------

test('default off: an entity with no weeklyDigest config is never due', () => {
  assert.equal(weeklyDigestDue({ domain: 'x.com', ownerEmail: 'a@b.c' }, MONDAY_13), false);
});

test('disabled: never due', () => {
  assert.equal(weeklyDigestDue(entity({}, { enabled: false }), MONDAY_13), false);
});

test('no ownerEmail: never due', () => {
  assert.equal(weeklyDigestDue(entity({ ownerEmail: '' }), MONDAY_13), false);
});

// --- weeklyDigestDue: schedule ---------------------------------------------

test('due at the configured UTC weekday and hour, never sent before', () => {
  assert.equal(weeklyDigestDue(entity(), MONDAY_13), true);
});

test('wrong hour, not due', () => {
  assert.equal(weeklyDigestDue(entity(), MONDAY_13 + HOUR), false);
  assert.equal(weeklyDigestDue(entity(), MONDAY_13 - HOUR), false);
});

test('wrong weekday, not due', () => {
  assert.equal(weeklyDigestDue(entity(), MONDAY_13 + DAY), false);
});

test('a different configured day+hour moves the schedule', () => {
  // 2026-08-16 is a Sunday.
  const e = entity({}, { dayOfWeek: 0, hour: 9 });
  assert.equal(weeklyDigestDue(e, Date.parse('2026-08-16T09:00:00Z')), true);
  assert.equal(weeklyDigestDue(e, Date.parse('2026-08-16T13:00:00Z')), false);
  assert.equal(weeklyDigestDue(e, MONDAY_13), false);
});

test('sent 7 days ago, due again', () => {
  assert.equal(weeklyDigestDue(entity({ lastWeeklyDigestAt: new Date(MONDAY_13 - 7 * DAY) }), MONDAY_13), true);
});

test('stamped moments ago (replayed fire in the same hour), not due', () => {
  const e = entity({ lastWeeklyDigestAt: new Date(MONDAY_13 - 5 * 60 * 1000) });
  assert.equal(weeklyDigestDue(e, MONDAY_13 + 30 * 60 * 1000), false);
});

test('elapsed-time guard sits under a nominal week so an early tick still sends', () => {
  assert.ok(MIN_GAP_MS < WEEK_MS);
  const e = entity({ lastWeeklyDigestAt: new Date(MONDAY_13 - MIN_GAP_MS) });
  assert.equal(weeklyDigestDue(e, MONDAY_13), true);
  const tooSoon = entity({ lastWeeklyDigestAt: new Date(MONDAY_13 - MIN_GAP_MS + 60 * 1000) });
  assert.equal(weeklyDigestDue(tooSoon, MONDAY_13), false);
});

test('unreadable stamp is treated as never sent, not as a block', () => {
  assert.equal(weeklyDigestDue(entity({ lastWeeklyDigestAt: 'not a date' }), MONDAY_13), true);
});

// --- weeklyDigestDue: DST-adjacent -----------------------------------------
// The schedule is pure UTC, so a 23- or 25-hour local day must neither skip a
// week nor send twice. 2026-03-08 (US spring-forward) and 2026-11-01 (fall-back)
// are both Sundays, so the Mondays either side of them are the interesting ticks.

test('DST spring-forward week: due at the next UTC Monday match, exactly once', () => {
  const before = Date.parse('2026-03-02T13:00:00Z'); // Monday
  const after = Date.parse('2026-03-09T13:00:00Z');  // Monday, after spring-forward
  const e = entity({ lastWeeklyDigestAt: new Date(before) });
  assert.equal(weeklyDigestDue(e, after), true);
  // 2026-03-08 is the 23-hour local day: wrong weekday, never a send.
  assert.equal(weeklyDigestDue(e, Date.parse('2026-03-08T13:00:00Z')), false);
  // Stamped at 13:00, a second fire later in the same UTC hour is inside the guard.
  const stamped = entity({ lastWeeklyDigestAt: new Date(after) });
  assert.equal(weeklyDigestDue(stamped, after + 45 * 60 * 1000), false);
});

test('DST fall-back week: the 25-hour local day does not produce a second send', () => {
  const before = Date.parse('2026-10-26T13:00:00Z'); // Monday
  const after = Date.parse('2026-11-02T13:00:00Z');  // Monday, after fall-back
  const e = entity({ lastWeeklyDigestAt: new Date(before) });
  assert.equal(weeklyDigestDue(e, after), true);
  // 2026-11-01 is the 25-hour local day — a Sunday, so wrong weekday anyway.
  assert.equal(weeklyDigestDue(e, Date.parse('2026-11-01T13:00:00Z')), false);
  // The local-time hour of the stamped send shifts by one across the boundary,
  // but the UTC schedule does not: 168 UTC hours apart either way.
  assert.equal(after - before, 7 * DAY);
});

// --- summarizeWeek ----------------------------------------------------------

const SINCE = new Date(MONDAY_13 - 7 * DAY);
const UNTIL = new Date(MONDAY_13);

function msg(role, content, offsetDaysBeforeUntil, extra = {}) {
  return {
    role,
    content,
    timestamp: new Date(MONDAY_13 - offsetDaysBeforeUntil * DAY),
    ...extra,
  };
}

test('zero activity: no conversations at all', () => {
  const stats = summarizeWeek({ conversations: [], unansweredCount: 0, since: SINCE, until: UNTIL });
  assert.equal(stats.hasActivity, false);
  assert.equal(stats.visitorMessages, 0);
  assert.equal(stats.topQuestions.length, 0);
});

test('zero activity: a conversation whose every message predates the window', () => {
  const stats = summarizeWeek({
    conversations: [{ createdAt: new Date(MONDAY_13 - 30 * DAY), messages: [msg('user', 'Old question?', 20), msg('assistant', 'Old answer', 20)] }],
    since: SINCE,
    until: UNTIL,
  });
  assert.equal(stats.hasActivity, false);
  assert.equal(stats.visitorMessages, 0);
});

test('counts messages, conversations, handoffs and unanswered in the window', () => {
  const stats = summarizeWeek({
    conversations: [
      {
        createdAt: new Date(MONDAY_13 - 3 * DAY),
        messages: [msg('user', 'What time do you open?', 3), msg('assistant', 'We open at 7.', 3)],
        pendingQuestions: [{ text: 'Do you cater?', askedAt: new Date(MONDAY_13 - 2 * DAY) }],
        handoffPending: true,
      },
      {
        createdAt: new Date(MONDAY_13 - 40 * DAY), // returning visitor, not new
        messages: [msg('user', 'Do you ship?', 1), msg('assistant', 'We do.', 1), msg('owner_reply', 'Hi, yes we ship.', 1)],
      },
    ],
    unansweredCount: 2,
    since: SINCE,
    until: UNTIL,
  });

  assert.equal(stats.visitorMessages, 2);
  assert.equal(stats.leoReplies, 2);
  assert.equal(stats.ownerReplies, 1);
  assert.equal(stats.activeConversations, 2);
  assert.equal(stats.newConversations, 1);
  assert.equal(stats.handoffs, 1);
  assert.equal(stats.stillWaiting, 1);
  assert.equal(stats.unanswered, 2);
  assert.equal(stats.hasActivity, true);
});

test('test-mode conversations never reach an owner total', () => {
  const stats = summarizeWeek({
    conversations: [{ isTest: true, createdAt: new Date(MONDAY_13 - DAY), messages: [msg('user', 'smoke', 1), msg('assistant', 'ok', 1)] }],
    since: SINCE,
    until: UNTIL,
  });
  assert.equal(stats.hasActivity, false);
  assert.equal(stats.visitorMessages, 0);
});

test('window is half-open: the end instant belongs to the next week', () => {
  const stats = summarizeWeek({
    conversations: [{ messages: [{ role: 'user', content: 'Edge', timestamp: UNTIL }] }],
    since: SINCE,
    until: UNTIL,
  });
  assert.equal(stats.visitorMessages, 0);
  const atStart = summarizeWeek({
    conversations: [{ messages: [{ role: 'user', content: 'Edge', timestamp: SINCE }] }],
    since: SINCE,
    until: UNTIL,
  });
  assert.equal(atStart.visitorMessages, 1);
});

test('quick-reply taps count as messages but never as top questions', () => {
  const stats = summarizeWeek({
    conversations: [{
      messages: [
        msg('user', 'Yes', 1, { type: 'interactive' }),
        msg('user', 'Yes', 2, { type: 'interactive' }),
        msg('user', 'Do you have gluten free bread?', 3),
      ],
    }],
    since: SINCE,
    until: UNTIL,
  });
  assert.equal(stats.visitorMessages, 3);
  assert.equal(stats.topQuestions.length, 1);
  assert.match(stats.topQuestions[0].question, /gluten free/);
});

test('top questions are ordered by count, highest first, and capped', () => {
  const messages = [];
  // Three near-identical "hours" questions, two "parking", one "wifi".
  messages.push(msg('user', 'What time do you open?', 1));
  messages.push(msg('user', 'What time do you open today?', 2));
  messages.push(msg('user', 'What time do you open on Sunday?', 3));
  messages.push(msg('user', 'Is there parking nearby?', 4));
  messages.push(msg('user', 'Is there parking close by?', 5));
  messages.push(msg('user', 'Do you have wifi for guests?', 6));

  const stats = summarizeWeek({ conversations: [{ messages }], since: SINCE, until: UNTIL });
  const counts = stats.topQuestions.map((q) => q.count);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  assert.equal(stats.topQuestions[0].count, 3);
  assert.ok(stats.topQuestions.length <= 5);
});

// --- renderWeeklyDigestBody -------------------------------------------------

test('zero activity renders null, suppressing the email', () => {
  assert.equal(renderWeeklyDigestBody('Example Bakery', null), null);
  assert.equal(renderWeeklyDigestBody('Example Bakery', { hasActivity: false, visitorMessages: 0, topQuestions: [] }), null);
  const empty = summarizeWeek({ conversations: [], since: SINCE, until: UNTIL });
  assert.equal(renderWeeklyDigestBody('Example Bakery', empty, { since: SINCE, until: UNTIL }), null);
});

test('body reports the counts, the window and the entity name', () => {
  const stats = summarizeWeek({
    conversations: [{
      createdAt: new Date(MONDAY_13 - 2 * DAY),
      messages: [msg('user', 'What time do you open?', 2), msg('assistant', 'At 7.', 2)],
      pendingQuestions: [{ text: 'Do you cater?', askedAt: new Date(MONDAY_13 - 2 * DAY) }],
      handoffPending: true,
    }],
    unansweredCount: 1,
    since: SINCE,
    until: UNTIL,
  });
  const body = renderWeeklyDigestBody('Example Bakery', stats, { since: SINCE, until: UNTIL });

  assert.match(body, /Example Bakery/);
  assert.match(body, /2026-08-03 to 2026-08-10/);
  assert.match(body, /1 visitor message answered across 1 conversation/);
  assert.match(body, /1 new conversation started/);
  assert.match(body, /1 question passed to you/);
  assert.match(body, /1 conversation still waiting on your reply/);
  assert.match(body, /1 question Leo couldn't answer/);
  assert.match(body, /leo-ai\.app\/#\/unanswered/);
  assert.match(body, /— Leo$/);
});

test('zero-valued lines are omitted rather than printed as 0', () => {
  const stats = summarizeWeek({
    conversations: [{ createdAt: new Date(MONDAY_13 - 40 * DAY), messages: [msg('user', 'Do you ship?', 1), msg('assistant', 'We do.', 1)] }],
    since: SINCE,
    until: UNTIL,
  });
  const body = renderWeeklyDigestBody('Example Bakery', stats, { since: SINCE, until: UNTIL });
  assert.doesNotMatch(body, /0 /);
  assert.doesNotMatch(body, /passed to you/);
  assert.doesNotMatch(body, /still waiting/);
  assert.doesNotMatch(body, /couldn't answer/);
  // With nothing unanswered the closing link is the dashboard, not /unanswered.
  assert.doesNotMatch(body, /#\/unanswered/);
});

test('plural agreement on the headline counts', () => {
  const stats = summarizeWeek({
    conversations: [
      { messages: [msg('user', 'One?', 1), msg('assistant', 'a', 1)] },
      { messages: [msg('user', 'Two?', 2), msg('assistant', 'b', 2)] },
    ],
    since: SINCE,
    until: UNTIL,
  });
  const body = renderWeeklyDigestBody('Example Bakery', stats, { since: SINCE, until: UNTIL });
  assert.match(body, /2 visitor messages answered across 2 conversations/);
});

test('summary counts come before the most-asked list', () => {
  const stats = summarizeWeek({
    conversations: [{ messages: [msg('user', 'What time do you open?', 1), msg('assistant', 'At 7.', 1)] }],
    since: SINCE,
    until: UNTIL,
  });
  const body = renderWeeklyDigestBody('Example Bakery', stats, { since: SINCE, until: UNTIL });
  assert.ok(body.indexOf('visitor message') < body.indexOf('Most asked:'));
  assert.match(body, /Most asked:\n {2}1×\s+What time do you open\?/);
});

test('a missing window still renders a usable body', () => {
  const stats = summarizeWeek({
    conversations: [{ messages: [msg('user', 'Hi?', 1), msg('assistant', 'Hello', 1)] }],
    since: SINCE,
    until: UNTIL,
  });
  const body = renderWeeklyDigestBody('Example Bakery', stats);
  assert.match(body, /Example Bakery this week:/);
});
