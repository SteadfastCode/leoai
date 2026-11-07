// Weekly "what Leo did" digest contracts (LEO-042): the pure due-date
// calculation (DST-adjacent), the week summariser's activity detection, and
// the body renderer's zero-activity suppression and line ordering.
//
// Nothing here touches the DB or a real mailer. The tick IS exercised (LEO-100
// — the claim/send/rollback sequence is the whole point of that item), but only
// with the Entity model, the stats collector and the mailer injected, so no
// send can leave the process and no query can reach Mongo.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  weeklyDigestDue,
  weeklyDigestDecision,
  summarizeWeek,
  renderWeeklyDigestBody,
  runWeeklyDigestTick,
  MIN_GAP_MS,
  CATCHUP_MS,
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

// --- weeklyDigestDue: the catch-up arm (LEO-084) ----------------------------
// One `cron.schedule('0 * * * *')` fire drives this, and Railway redeploys on
// every merge, so losing the single top-of-the-hour tick that matches an
// entity's slot is ordinary. Every assertion below is one of two kinds: "a
// missed slot is recovered" or "a second send inside the same week is
// impossible". The second kind is the one that must never regress — a duplicate
// digest is an owner unsubscribing.

test('the catch-up window sits past a nominal week, so a healthy entity is always claimed by its own slot first', () => {
  assert.ok(CATCHUP_MS > WEEK_MS, 'a catch-up window inside the week would pre-empt the slot');
  assert.ok(MIN_GAP_MS < WEEK_MS, 'a gap guard over the week would skip every send');
});

test('missed slot: wrong hour, stamp 8 days old — due as catch-up', () => {
  const e = entity({ lastWeeklyDigestAt: new Date(MONDAY_13 - 8 * DAY) });
  // Thursday 21:00 UTC — neither the configured day nor the configured hour.
  const offSlot = Date.parse('2026-08-13T21:00:00Z');
  const d = weeklyDigestDecision(e, offSlot);
  assert.equal(d.due, true);
  assert.equal(d.reason, 'catch-up');
  assert.match(d.detail, /Monday 13:00 UTC slot was missed/);
});

test('missed slot: wrong hour, stamp 7 days old — NOT due, the slot is still within reach', () => {
  const e = entity({ lastWeeklyDigestAt: new Date(MONDAY_13 - 7 * DAY) });
  const d = weeklyDigestDecision(e, MONDAY_13 + 3 * 60 * 60 * 1000); // Monday 16:00
  assert.equal(d.due, false);
  assert.equal(d.reason, 'off-schedule');
});

test('the scheduled hour with a stamp 1h old: NOT due — the gap guard holds', () => {
  const e = entity({ lastWeeklyDigestAt: new Date(MONDAY_13 - 60 * 60 * 1000) });
  const d = weeklyDigestDecision(e, MONDAY_13);
  assert.equal(d.due, false);
  assert.equal(d.reason, 'gap-guard');
});

test('catch-up can never fire inside the gap guard, at any hour of the week', () => {
  // Stamped one hour before each probe: no hour of any day may produce a send.
  for (let h = 0; h < 24 * 7; h++) {
    const at = MONDAY_13 + h * 60 * 60 * 1000;
    const e = entity({ lastWeeklyDigestAt: new Date(at - 60 * 60 * 1000) });
    assert.equal(weeklyDigestDue(e, at), false, `a send fired ${h}h in, one hour after the last one`);
  }
});

test('one week of hourly ticks after a real send produces exactly one more send', () => {
  // The whole point of the catch-up arm: it recovers a miss without ever
  // turning the hourly tick into a second digest.
  let stamp = new Date(MONDAY_13);
  let sends = 0;
  for (let h = 1; h <= 24 * 8; h++) {
    const at = MONDAY_13 + h * 60 * 60 * 1000;
    if (weeklyDigestDue(entity({ lastWeeklyDigestAt: stamp }), at)) {
      sends++;
      stamp = new Date(at);
    }
  }
  assert.equal(sends, 1, 'eight days of ticks must yield the next Monday send and nothing else');
});

test('no stamp at the scheduled slot is due; no stamp off-slot waits for it', () => {
  const first = weeklyDigestDecision(entity(), MONDAY_13);
  assert.equal(first.due, true);
  assert.equal(first.reason, 'first-run');
  // Never sent means nothing was missed — flipping the toggle on must not mail
  // the owner in the same minute.
  const held = weeklyDigestDecision(entity(), MONDAY_13 + 9 * DAY);
  assert.equal(held.due, false);
  assert.equal(held.reason, 'awaiting-first-slot');
});

test('a disabled entity is never due, however stale its stamp', () => {
  const e = entity({ lastWeeklyDigestAt: new Date(MONDAY_13 - 400 * DAY) }, { enabled: false });
  assert.equal(weeklyDigestDue(e, MONDAY_13), false);
  assert.equal(weeklyDigestDecision(e, MONDAY_13).reason, 'disabled');
  // Same for an entity with nowhere to send.
  const noEmail = entity({ ownerEmail: '', lastWeeklyDigestAt: new Date(MONDAY_13 - 400 * DAY) });
  assert.equal(weeklyDigestDue(noEmail, MONDAY_13), false);
  assert.equal(weeklyDigestDecision(noEmail, MONDAY_13).reason, 'no-recipient');
});

test('a stamp in the future holds rather than sending', () => {
  const e = entity({ lastWeeklyDigestAt: new Date(MONDAY_13 + 2 * DAY) });
  const d = weeklyDigestDecision(e, MONDAY_13);
  assert.equal(d.due, false);
  assert.equal(d.reason, 'future-stamp');
});

test('every decision carries a reason and a detail naming the slot', () => {
  const cases = [
    entity(),
    entity({}, { enabled: false }),
    entity({ lastWeeklyDigestAt: new Date(MONDAY_13 - 8 * DAY) }),
    entity({ lastWeeklyDigestAt: new Date(MONDAY_13 - 60 * 1000) }),
  ];
  for (const e of cases) {
    const d = weeklyDigestDecision(e, MONDAY_13 + 5 * 60 * 60 * 1000);
    assert.equal(typeof d.reason, 'string');
    assert.ok(d.reason.length, 'a decision with no reason is a silent drop in the log');
    assert.ok(d.detail.length, 'the light tier prints detail, so it may never be empty');
  }
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

// --- summarizeWeek: the week's handoff total (LEO-092) ----------------------
// pendingQuestions is emptied when the owner replies (dashboard reply) or
// resolves the handoff out-of-band, so the week's total has to come from the
// durable handoffLog — otherwise an owner who answered everything is told
// nothing was ever passed to them, and `handoffs` is just `stillWaiting` again.

test('answered handoffs still count: handoffLog outlives an emptied pendingQuestions', () => {
  const stats = summarizeWeek({
    conversations: [{
      createdAt: new Date(MONDAY_13 - 3 * DAY),
      messages: [msg('user', 'Do you cater?', 3), msg('assistant', 'Let me ask the team.', 3), msg('owner_reply', 'We do!', 2)],
      handoffLog: [
        { text: 'Do you cater?', askedAt: new Date(MONDAY_13 - 3 * DAY) },
        { text: 'Can you do 40 people?', askedAt: new Date(MONDAY_13 - 2 * DAY) },
      ],
      pendingQuestions: [], // owner answered both, so the array was filtered empty
      handoffPending: false,
    }],
    since: SINCE,
    until: UNTIL,
  });

  assert.equal(stats.handoffs, 2);
  assert.equal(stats.stillWaiting, 0);
  assert.equal(stats.handoffsFromLegacyPending, 0);
  const body = renderWeeklyDigestBody('Example Bakery', stats, { since: SINCE, until: UNTIL });
  assert.match(body, /2 questions passed to you/);
  assert.doesNotMatch(body, /still waiting/);
});

test('an open handoff sits in both arrays and is counted once', () => {
  const askedAt = new Date(MONDAY_13 - 2 * DAY);
  const stats = summarizeWeek({
    conversations: [{
      messages: [msg('user', 'Do you cater?', 2), msg('assistant', 'Let me ask.', 2)],
      handoffLog: [{ text: 'Do you cater?', askedAt }],
      pendingQuestions: [{ text: 'Do you cater?', askedAt }],
      handoffPending: true,
    }],
    since: SINCE,
    until: UNTIL,
  });

  assert.equal(stats.handoffs, 1);
  assert.equal(stats.stillWaiting, 1);
});

test('handoffs is the week total, not a near-duplicate of stillWaiting', () => {
  const openAt = new Date(MONDAY_13 - DAY);
  const stats = summarizeWeek({
    conversations: [
      {
        messages: [msg('user', 'Do you cater?', 4), msg('assistant', 'Asking.', 4)],
        handoffLog: [{ text: 'Do you cater?', askedAt: new Date(MONDAY_13 - 4 * DAY) }],
        pendingQuestions: [],
        handoffPending: false,
      },
      {
        messages: [msg('user', 'Are you open Easter?', 1), msg('assistant', 'Asking.', 1)],
        handoffLog: [{ text: 'Are you open Easter?', askedAt: openAt }],
        pendingQuestions: [{ text: 'Are you open Easter?', askedAt: openAt }],
        handoffPending: true,
      },
    ],
    since: SINCE,
    until: UNTIL,
  });

  assert.equal(stats.handoffs, 2);
  assert.equal(stats.stillWaiting, 1);
  const body = renderWeeklyDigestBody('Example Bakery', stats, { since: SINCE, until: UNTIL });
  assert.match(body, /2 questions passed to you/);
  assert.match(body, /1 conversation still waiting on your reply/);
});

test('conversations older than handoffLog keep reporting from pendingQuestions', () => {
  const stats = summarizeWeek({
    conversations: [{
      messages: [msg('user', 'Do you deliver?', 2), msg('assistant', 'Asking.', 2)],
      // No handoffLog at all — written before the field existed.
      pendingQuestions: [{ text: 'Do you deliver?', askedAt: new Date(MONDAY_13 - 2 * DAY) }],
      handoffPending: true,
    }],
    since: SINCE,
    until: UNTIL,
  });

  assert.equal(stats.handoffs, 1);
  assert.equal(stats.handoffsFromLegacyPending, 1);
});

test('a logged handoff from an earlier week is not this week\'s news', () => {
  const stats = summarizeWeek({
    conversations: [{
      messages: [msg('user', 'Anything new?', 1), msg('assistant', 'Not today.', 1)],
      handoffLog: [{ text: 'Do you cater?', askedAt: new Date(MONDAY_13 - 30 * DAY) }],
      pendingQuestions: [],
    }],
    since: SINCE,
    until: UNTIL,
  });

  assert.equal(stats.handoffs, 0);
  const body = renderWeeklyDigestBody('Example Bakery', stats, { since: SINCE, until: UNTIL });
  assert.doesNotMatch(body, /passed to you/);
});

test('the same question asked again after a reply is two handoffs', () => {
  const stats = summarizeWeek({
    conversations: [{
      messages: [msg('user', 'Do you cater?', 5), msg('assistant', 'Asking.', 5)],
      handoffLog: [
        { text: 'Do you cater?', askedAt: new Date(MONDAY_13 - 5 * DAY) },
        { text: 'Do you cater?', askedAt: new Date(MONDAY_13 - 2 * DAY) },
      ],
      pendingQuestions: [],
    }],
    since: SINCE,
    until: UNTIL,
  });

  assert.equal(stats.handoffs, 2);
});

test('an answered handoff alone is activity worth an email', () => {
  const stats = summarizeWeek({
    conversations: [{
      handoffLog: [{ text: 'Do you cater?', askedAt: new Date(MONDAY_13 - 2 * DAY) }],
      pendingQuestions: [],
    }],
    since: SINCE,
    until: UNTIL,
  });

  assert.equal(stats.handoffs, 1);
  assert.equal(stats.hasActivity, true);
  assert.ok(renderWeeklyDigestBody('Example Bakery', stats, { since: SINCE, until: UNTIL }));
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

// --- renderWeeklyDigestBody: the do-not-relay list (LEO-100) ----------------
// "Most asked" is the only place this body prints visitor text verbatim, so it
// is the only place the owner's own never-relay list (LEO-047) has to be
// honoured. notifications.js withholds the same text from handoff SMS/email;
// without this the owner who said "never forward salary questions" received
// them anyway, once a week.

function mixedAsk() {
  return summarizeWeek({
    conversations: [{
      messages: [
        msg('user', 'What do you pay your staff?', 1),
        msg('assistant', 'I will pass that on.', 1),
        msg('user', 'What time do you open?', 2),
        msg('assistant', 'At 7.', 2),
      ],
    }],
    since: SINCE,
    until: UNTIL,
  });
}

test('a question on the do-not-relay list is absent from the body, the rest survive', () => {
  const body = renderWeeklyDigestBody('Example Bakery', mixedAsk(), {
    since: SINCE, until: UNTIL, doNotRelay: ['what do you pay'],
  });
  assert.doesNotMatch(body, /pay your staff/);
  assert.match(body, /Most asked:/);
  assert.match(body, /What time do you open\?/);
});

test('matching ignores case and whitespace, and the counts are left alone', () => {
  const stats = summarizeWeek({
    conversations: [{ messages: [msg('user', 'What do you   PAY your staff?', 1), msg('assistant', 'Passing it on.', 1)] }],
    since: SINCE,
    until: UNTIL,
  });
  const body = renderWeeklyDigestBody('Example Bakery', stats, {
    since: SINCE, until: UNTIL, doNotRelay: ['What Do You Pay'],
  });
  // Every most-asked row withheld: the block goes entirely, the digest still sends.
  assert.doesNotMatch(body, /Most asked/);
  assert.doesNotMatch(body, /staff/);
  // The aggregate is a number, not text, and is still reported.
  assert.match(body, /1 visitor message answered across 1 conversation/);
});

test('an empty, absent or non-matching do-not-relay list changes the body not at all', () => {
  const stats = mixedAsk();
  const plain = renderWeeklyDigestBody('Example Bakery', stats, { since: SINCE, until: UNTIL });
  assert.match(plain, /pay your staff/);
  for (const list of [[], null, undefined, ['nothing like this'], ['']]) {
    assert.equal(
      renderWeeklyDigestBody('Example Bakery', stats, { since: SINCE, until: UNTIL, doNotRelay: list }),
      plain
    );
  }
});

// --- renderWeeklyDigestBody: the headline's own zero (LEO-100) --------------
// Every line after the headline is zero-guarded; the headline was pushed
// unconditionally. Zero is reachable: conversationRetentionDays under seven
// days sweeps the conversations whose UnansweredQuestion rows remain, so a week
// can be real activity (unanswered > 0) with nothing left to count.

test('a week of nothing but unanswered questions never says "0 visitor messages"', () => {
  const stats = summarizeWeek({ conversations: [], unansweredCount: 3, since: SINCE, until: UNTIL });
  assert.equal(stats.visitorMessages, 0);
  assert.equal(stats.activeConversations, 0);
  assert.equal(stats.hasActivity, true);

  const body = renderWeeklyDigestBody('Example Bakery', stats, { since: SINCE, until: UNTIL });
  assert.ok(body, 'a week with unanswered questions is still worth an email');
  assert.doesNotMatch(body, /visitor message/);
  assert.doesNotMatch(body, /0 /);
  assert.match(body, /3 questions Leo couldn't answer/);
  assert.match(body, /#\/unanswered/);
});

test('one non-zero headline count still prints the headline', () => {
  // An owner reply touched a conversation but no visitor wrote: both numbers
  // are real, so the line reads, and only BOTH-zero drops it.
  const stats = summarizeWeek({
    conversations: [{ messages: [msg('owner_reply', 'Hi, yes we ship.', 1)] }],
    unansweredCount: 1,
    since: SINCE,
    until: UNTIL,
  });
  assert.equal(stats.visitorMessages, 0);
  assert.equal(stats.activeConversations, 1);
  const body = renderWeeklyDigestBody('Example Bakery', stats, { since: SINCE, until: UNTIL });
  assert.match(body, /0 visitor messages answered across 1 conversation/);
});

// --- runWeeklyDigestTick: claim, send, rollback (LEO-100) -------------------
// lastWeeklyDigestAt was stamped before the send and never put back, so one
// transient Resend failure cost the owner the whole week: the day+hour match
// plus MIN_GAP_MS makes a retry impossible until the next scheduled tick. The
// claim still comes FIRST — it is what stops a double-send — so what has to
// hold is that it is released when the send throws, kept when it does not, and
// released only by the tick that wrote it.
//
// The real send path is never reached: Entity, the stats collector and the
// mailer are all injected.

// Enough of the model that the tick's REAL filters decide every outcome.
// lastWeeklyDigestAt compares by time value, and null matches null-or-absent
// the way Mongo does — that equivalence is what the claim and the release ride
// on. find().lean() hands back copies, so the tick can never observe a
// mutation made after it read.
function fakeEntityModel(docs) {
  const sameStamp = (a, b) => {
    const at = a == null ? null : new Date(a).getTime();
    const bt = b == null ? null : new Date(b).getTime();
    return at === bt;
  };
  return {
    docs,
    filters: [],
    find(filter) {
      const want = filter && filter['weeklyDigest.enabled'];
      return {
        lean: async () => docs
          .filter((d) => want === undefined || ((d.weeklyDigest && d.weeklyDigest.enabled) || false) === want)
          .map((d) => ({ ...d })),
      };
    },
    async findOneAndUpdate(filter, update) {
      this.filters.push(filter);
      const doc = docs.find((d) => d.domain === filter.domain && sameStamp(d.lastWeeklyDigestAt, filter.lastWeeklyDigestAt));
      if (!doc) return null;
      const before = { ...doc };
      Object.assign(doc, update.$set);
      return before; // mongoose returns the pre-update doc by default
    },
  };
}

function digestDoc(overrides = {}) {
  return {
    domain: 'example.com',
    name: 'Example Bakery',
    ownerEmail: 'owner@example.com',
    weeklyDigest: { enabled: true, dayOfWeek: 1, hour: 13 },
    lastWeeklyDigestAt: new Date(MONDAY_13 - 7 * DAY),
    ...overrides,
  };
}

function activeWeek() {
  return summarizeWeek({
    conversations: [{ messages: [msg('user', 'Do you ship?', 1), msg('assistant', 'We do.', 1)] }],
    since: SINCE,
    until: UNTIL,
  });
}

// The failed-send path console.errors by design — keep that out of the test log
// while leaving the tiered debug lines running, so a broken log template still
// fails the test.
async function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

function stampMs(doc) {
  return doc.lastWeeklyDigestAt == null ? null : new Date(doc.lastWeeklyDigestAt).getTime();
}

test('a sent digest keeps its claim, and a second tick in the same hour refuses to double-send', async () => {
  const model = fakeEntityModel([digestDoc()]);
  const sends = [];
  const deps = {
    Entity: model,
    collectStats: async () => activeWeek(),
    send: async (to, subject, body) => { sends.push({ to, subject, body }); },
  };

  assert.equal(await runWeeklyDigestTick(MONDAY_13, deps), 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, 'owner@example.com');
  assert.match(sends[0].body, /1 visitor message answered/);
  assert.equal(stampMs(model.docs[0]), MONDAY_13);

  assert.equal(await runWeeklyDigestTick(MONDAY_13 + 60 * 1000, deps), 0);
  assert.equal(sends.length, 1);
  assert.equal(stampMs(model.docs[0]), MONDAY_13);
});

test('a failed send releases the claim, and the next tick retries inside the same week', async () => {
  const model = fakeEntityModel([digestDoc()]);
  const before = stampMs(model.docs[0]);
  let attempts = 0;
  const deps = {
    Entity: model,
    collectStats: async () => activeWeek(),
    send: async () => {
      attempts++;
      if (attempts === 1) throw new Error('Resend 503');
    },
  };

  assert.equal(await quietly(() => runWeeklyDigestTick(MONDAY_13, deps)), 0);
  assert.equal(attempts, 1);
  assert.equal(stampMs(model.docs[0]), before, 'the stamp this tick wrote is rolled back');

  // An hourly tick an hour later, still inside the owner's own week.
  assert.equal(await runWeeklyDigestTick(MONDAY_13 + 60 * 1000, deps), 1);
  assert.equal(attempts, 2);
  assert.equal(stampMs(model.docs[0]), MONDAY_13 + 60 * 1000);
});

test('an entity that never sent is released back to never, not to this tick', async () => {
  const model = fakeEntityModel([digestDoc({ lastWeeklyDigestAt: null })]);
  const deps = {
    Entity: model,
    collectStats: async () => activeWeek(),
    send: async () => { throw new Error('Resend 503'); },
  };

  assert.equal(await quietly(() => runWeeklyDigestTick(MONDAY_13, deps)), 0);
  assert.equal(stampMs(model.docs[0]), null);
  // ...so the first-run arm, not the gap guard, is what the retry meets.
  assert.equal(weeklyDigestDue(model.docs[0], MONDAY_13 + 60 * 1000), true);
});

test('the release is matched on this tick\'s own claim, so a concurrent stamp survives', async () => {
  const model = fakeEntityModel([digestDoc()]);
  const other = new Date(MONDAY_13 + 5 * 60 * 1000);
  const deps = {
    Entity: model,
    collectStats: async () => activeWeek(),
    // A second process claims and stamps its own send while this one is in the
    // mailer; the rollback must not put the week back for it.
    send: async () => {
      model.docs[0].lastWeeklyDigestAt = other;
      throw new Error('Resend 503');
    },
  };

  assert.equal(await quietly(() => runWeeklyDigestTick(MONDAY_13, deps)), 0);
  assert.equal(stampMs(model.docs[0]), other.getTime());
});

test('the tick filters the digest it sends through the entity\'s own do-not-relay list', async () => {
  const model = fakeEntityModel([digestDoc({ doNotRelay: ['what do you pay'] })]);
  const bodies = [];
  const deps = {
    Entity: model,
    collectStats: async () => mixedAsk(),
    send: async (to, subject, body) => { bodies.push(body); },
  };

  assert.equal(await runWeeklyDigestTick(MONDAY_13, deps), 1);
  assert.doesNotMatch(bodies[0], /pay your staff/);
  assert.match(bodies[0], /What time do you open\?/);
});

test('a quiet week neither emails nor claims the stamp', async () => {
  const model = fakeEntityModel([digestDoc()]);
  const before = stampMs(model.docs[0]);
  let sends = 0;
  const deps = {
    Entity: model,
    collectStats: async () => summarizeWeek({ conversations: [], since: SINCE, until: UNTIL }),
    send: async () => { sends++; },
  };

  assert.equal(await runWeeklyDigestTick(MONDAY_13, deps), 0);
  assert.equal(sends, 0);
  assert.equal(stampMs(model.docs[0]), before);
});
