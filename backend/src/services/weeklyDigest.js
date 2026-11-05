// Weekly "what Leo did" owner digest (LEO-042). DEFAULT OFF — no entity
// receives one until weeklyDigest.enabled is set on it, and an entity with
// nothing to report gets no email at all. A "0 messages this week" note is
// noise an owner would rightly unsubscribe from, and silence is the honest
// signal: Leo only writes when he actually did something.
//
// The week reported on is the seven UTC days ending at the tick that sends it.
//
// weeklyDigestDue / summarizeWeek / renderWeeklyDigestBody are pure (no DB, no
// network, no clock of their own) so the due calculation, the zero-activity
// suppression and the ordering of the body are unit-testable directly.
// runWeeklyDigestTick owns the queries and the one send.
//
// The due calculation has a CATCH-UP arm (LEO-084). One
// `cron.schedule('0 * * * *')` fire is the only thing that ever calls this, and
// the predicate used to require an exact UTC day+hour match. Miss that single
// fire — a container restart spanning the hour, and Railway redeploys on every
// merge — and a weekly sender lost a WHOLE WEEK of digest, silently. So the
// predicate is now due when the scheduled day+hour match, OR when
// lastWeeklyDigestAt is older than a catch-up window, and never inside the
// MIN_GAP_MS guard that makes a second send in the same week impossible.
// Same shape as digestDue in unansweredDigest.js and refreshDecision in
// leoRefresh.js.
//
// An entity that has NEVER sent is not caught up — it has missed nothing, and
// a digest the instant the toggle flips is not what the day+hour setting
// means. It waits for its scheduled slot.
//
// Debug tiers — WEEKLY_DIGEST_LOG_LEVEL = off | light | normal | verbose:
//   light (default) one line per entity decision, naming the REASON it was
//                   taken or held — slot match, catch-up after N days, gap
//                   guard, disabled — plus every post-due outcome (the send,
//                   zero activity, a stamp that moved under us)
//   normal          adds the tick-level counts
//   verbose         adds the raw schedule + last-send stamp each decision read
// This runs away from a human (an hourly cron tick), so the light tier always
// says the SOURCE of a send — the entity's own schedule and the window it
// covered — not just that mail went out.

const Entity = require('../models/Entity');
const Conversation = require('../models/Conversation');
const UnansweredQuestion = require('../models/UnansweredQuestion');
const { shapeTopQuestions, dayKey } = require('./analytics');
const { sendEmailRaw } = require('./email');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// Elapsed-time guard, deliberately under the nominal week so a tick landing a
// little early (clock skew) still sends, while a second fire inside the same
// scheduled hour is always inside the guard and can never double-send. The
// schedule is UTC throughout, so a 23- or 25-hour local day never shifts it.
const MIN_GAP_MS = 6 * DAY_MS;

// How stale lastWeeklyDigestAt must be before a tick in ANY hour takes the
// send, because the scheduled slot was evidently missed. Set past the nominal
// week (8d) so a healthy entity is always claimed by its own slot first and the
// catch-up arm only ever fires after something actually went wrong.
//
// Consequence, deliberately accepted: a caught-up digest goes out OUTSIDE the
// owner's chosen day+hour, once, and covers the seven days ending at that tick
// rather than at the slot. Roughly-on-time beats silently skipped; sending the
// same week twice is the one thing MIN_GAP_MS will not allow.
const CATCHUP_MS = 8 * DAY_MS;

// How many "most asked" questions the body lists.
const TOP_QUESTION_LIMIT = 5;

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.WEEKLY_DIGEST_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[WeeklyDigest] ${message}`);
}

// Gaps here are days, so one rounded unit is the readable form.
function formatGap(ms) {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 48) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatSlot(dayOfWeek, hour) {
  const day = DAY_NAMES[dayOfWeek] || `day ${dayOfWeek}`;
  return `${day} ${String(hour).padStart(2, '0')}:00 UTC`;
}

// null means "never sent" — which includes an unreadable stamp: a decision made
// from a NaN compares false against every window and would wedge the entity out
// of the schedule entirely, the exact failure this catch-up arm exists to fix.
function lastSentMs(entity) {
  const raw = entity?.lastWeeklyDigestAt;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Why this entity's weekly digest is (or is not) due right now:
 * `{ due, reason, detail }`. Pure — `now` is injected, nothing is read from the
 * DB. `reason` is a stable slug for logs and tests; `detail` is the human half
 * of the light-tier line.
 *
 * `entity` needs weeklyDigest ({ enabled, dayOfWeek, hour }),
 * lastWeeklyDigestAt, and ownerEmail — with no address there is nowhere to
 * send, so it is never due.
 */
function weeklyDigestDecision(entity, now = Date.now()) {
  const cfg = entity?.weeklyDigest || {};
  if (!cfg.enabled) {
    return { due: false, reason: 'disabled', detail: 'the weekly digest is off for this entity' };
  }
  if (!entity?.ownerEmail) {
    return { due: false, reason: 'no-recipient', detail: 'no ownerEmail on the entity — nowhere to send' };
  }

  const hour = cfg.hour ?? 13;
  const dayOfWeek = cfg.dayOfWeek ?? 1;
  const slot = formatSlot(dayOfWeek, hour);

  const at = new Date(now);
  const onSchedule = at.getUTCHours() === hour && at.getUTCDay() === dayOfWeek;
  const last = lastSentMs(entity);

  if (last === null) {
    return onSchedule
      ? { due: true, reason: 'first-run', detail: `never sent, and now is its ${slot} slot` }
      : { due: false, reason: 'awaiting-first-slot', detail: `never sent; holding for its ${slot} slot` };
  }

  const elapsed = now - last;
  if (elapsed < 0) {
    return { due: false, reason: 'future-stamp', detail: `last send is stamped ${formatGap(-elapsed)} in the future (clock skew) — holding off rather than risk a double send` };
  }
  if (elapsed < MIN_GAP_MS) {
    return { due: false, reason: 'gap-guard', detail: `last sent ${formatGap(elapsed)} ago, inside the ${formatGap(MIN_GAP_MS)} gap guard` };
  }
  if (onSchedule) {
    return { due: true, reason: 'slot-match', detail: `now is its ${slot} slot; last sent ${formatGap(elapsed)} ago` };
  }
  if (elapsed >= CATCHUP_MS) {
    return { due: true, reason: 'catch-up', detail: `catch-up after ${formatGap(elapsed)} — its ${slot} slot was missed and the ${formatGap(CATCHUP_MS)} window has passed` };
  }
  return { due: false, reason: 'off-schedule', detail: `now is not its ${slot} slot, and last sent ${formatGap(elapsed)} ago is inside the ${formatGap(CATCHUP_MS)} catch-up window` };
}

/** Boolean half of weeklyDigestDecision. `now` is injected so this stays testable. */
function weeklyDigestDue(entity, now = Date.now()) {
  return weeklyDigestDecision(entity, now).due;
}

// Half-open [since, until): the instant a window ends is the next window's
// first instant, so a message on the boundary is counted exactly once.
function inWindow(at, since, until) {
  const t = new Date(at ?? NaN).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= new Date(since).getTime() && t < new Date(until).getTime();
}

// One handoff is one (question, moment) pair. chat.js writes the same text and
// askedAt into both handoffLog and pendingQuestions, so a still-open handoff is
// present in both arrays and must be counted exactly once.
function handoffKey(q) {
  return `${q?.text ?? ''}|${new Date(q?.askedAt ?? NaN).getTime()}`;
}

/**
 * Roll a week of conversation documents into the numbers the digest reports.
 * Pure — the caller does the fetching.
 *
 * `conversations` are lean Conversation docs (messages, pendingQuestions,
 * handoffLog, handoffPending, createdAt). `unansweredCount` is the count of
 * UnansweredQuestion rows created in the same window.
 *
 * `hasActivity` is the single definition of "this entity did something this
 * week"; the renderer suppresses the whole email when it is false.
 */
function summarizeWeek({ conversations = [], unansweredCount = 0, since, until } = {}) {
  const stats = {
    visitorMessages: 0,
    leoReplies: 0,
    ownerReplies: 0,
    activeConversations: 0,
    newConversations: 0,
    handoffs: 0,
    // Of stats.handoffs, how many were only visible in pendingQuestions —
    // i.e. came from a conversation older than handoffLog. Diagnostic only.
    handoffsFromLegacyPending: 0,
    stillWaiting: 0,
    unanswered: Math.max(0, Number(unansweredCount) || 0),
    topQuestions: [],
  };

  const asked = [];
  for (const convo of conversations || []) {
    // Test traffic (MCP / the routine's own smoke) must never reach an owner's
    // numbers; the query filters it too, this is the belt to that braces.
    if (!convo || convo.isTest === true) continue;

    let touched = 0;
    for (const msg of convo.messages || []) {
      if (!inWindow(msg?.timestamp, since, until)) continue;
      touched++;
      if (msg.role === 'user') {
        stats.visitorMessages++;
        // Quick-reply taps are stored as user messages whose content is the
        // button label ("Yes", "1"), so they would crowd out real questions.
        if (msg.type !== 'interactive' && typeof msg.content === 'string') {
          asked.push({ text: msg.content, askedAt: msg.timestamp });
        }
      } else if (msg.role === 'assistant') {
        stats.leoReplies++;
      } else if (msg.role === 'owner_reply') {
        stats.ownerReplies++;
      }
    }
    if (touched) stats.activeConversations++;
    if (inWindow(convo.createdAt, since, until)) stats.newConversations++;

    // The week's handoff TOTAL, not what is left over. pendingQuestions is
    // emptied when the owner replies or resolves the handoff (dashboard.js
    // reply / resolve-handoff), so counting only that array made every
    // answered handoff vanish from the week: an owner who answered everything
    // was told nothing had been passed to them, and `handoffs` degenerated
    // into a near-copy of `stillWaiting`. handoffLog is the durable record,
    // written when the handoff fires and never pruned. pendingQuestions is
    // still read so conversations that predate the log keep reporting.
    const counted = new Set();
    for (const q of convo.handoffLog || []) {
      if (inWindow(q?.askedAt, since, until)) counted.add(handoffKey(q));
    }
    const fromLog = counted.size;
    for (const q of convo.pendingQuestions || []) {
      if (inWindow(q?.askedAt, since, until)) counted.add(handoffKey(q));
    }
    stats.handoffs += counted.size;
    stats.handoffsFromLegacyPending += counted.size - fromLog;
    // Counted over the conversations the caller fetched (those active in the
    // window), not the whole history — a year-old unanswered handoff is not
    // this week's news.
    if (convo.handoffPending === true) stats.stillWaiting++;
  }

  stats.topQuestions = shapeTopQuestions(asked, TOP_QUESTION_LIMIT);
  stats.hasActivity =
    stats.visitorMessages + stats.leoReplies + stats.handoffs + stats.unanswered > 0;
  return stats;
}

function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Plain-text digest body, or null when the entity had no activity at all —
 * zero activity suppresses the email entirely rather than sending an empty
 * report.
 *
 * Line order is fixed: the headline counts first (always in the same order so
 * a weekly reader's eye lands in the same place), then the most-asked list in
 * the order shapeTopQuestions returns — count descending, most recent first on
 * a tie.
 */
function renderWeeklyDigestBody(entityName, stats, { since, until } = {}) {
  if (!stats || !stats.hasActivity) return null;

  const name = entityName || 'your site';
  const span = since && until ? ` (${dayKey(since)} to ${dayKey(until)})` : '';

  const lines = [
    `Here's what Leo did for ${name} this week${span}:`,
    '',
    `  ${plural(stats.visitorMessages, 'visitor message')} answered across ${plural(stats.activeConversations, 'conversation')}`,
  ];
  if (stats.newConversations) lines.push(`  ${plural(stats.newConversations, 'new conversation')} started`);
  if (stats.handoffs) lines.push(`  ${plural(stats.handoffs, 'question')} passed to you`);
  if (stats.stillWaiting) lines.push(`  ${plural(stats.stillWaiting, 'conversation')} still waiting on your reply`);
  if (stats.ownerReplies) lines.push(`  ${plural(stats.ownerReplies, 'reply')} you sent back`);
  if (stats.unanswered) lines.push(`  ${plural(stats.unanswered, 'question')} Leo couldn't answer`);

  if (stats.topQuestions.length) {
    lines.push('', 'Most asked:');
    for (const q of stats.topQuestions) lines.push(`  ${q.count}×  ${q.question}`);
  }

  lines.push(
    '',
    stats.unanswered
      ? 'Answer what Leo missed once and he learns it for every future visitor:'
      : 'Your dashboard has the full picture:',
    stats.unanswered ? 'https://leo-ai.app/#/unanswered' : 'https://leo-ai.app',
    '',
    '— Leo'
  );

  return lines.join('\n');
}

/**
 * Fetch one entity's week and summarise it. Pulls the conversations active in
 * the window (transcripts included — fine at pre-alpha volume, and the shaping
 * stays in the pure summariser rather than becoming an aggregate nobody can
 * test) and counts the unanswered questions logged in the same window.
 */
async function collectWeekStats(domain, since, until) {
  const conversations = await Conversation.find({
    domain,
    isTest: { $ne: true },
    $or: [{ lastActiveAt: { $gte: since } }, { updatedAt: { $gte: since } }],
  })
    .select('messages pendingQuestions handoffLog handoffPending createdAt isTest')
    .lean();

  const unansweredCount = await UnansweredQuestion.countDocuments({
    entityDomain: domain,
    createdAt: { $gte: since, $lt: until },
  });

  return summarizeWeek({ conversations, unansweredCount, since, until });
}

/**
 * One pass over digest-enabled entities. Runs beside the LeoRefresh hourly
 * tick. Skips silently when an entity had zero activity, and stamps
 * lastWeeklyDigestAt atomically (matched on its previous value, the same
 * pattern the unanswered digest and the handoff follow-up use) so concurrent
 * ticks can never double-send. Returns the number of emails sent.
 */
async function runWeeklyDigestTick(now = Date.now()) {
  const entities = await Entity.find({ 'weeklyDigest.enabled': true }).lean();
  if (!entities.length) {
    debug('normal', 'no entity has weeklyDigest.enabled — nothing to do');
    return 0;
  }

  const until = new Date(now);
  const since = new Date(now - WEEK_MS);
  let sent = 0;
  let due = 0;

  for (const entity of entities) {
    const cfg = entity.weeklyDigest || {};
    const decision = weeklyDigestDecision(entity, now);
    debug('verbose', `${entity.domain} read entity.weeklyDigest (dayOfWeek ${cfg.dayOfWeek ?? 1}, hour ${cfg.hour ?? 13} UTC), lastWeeklyDigestAt ${entity.lastWeeklyDigestAt ? new Date(entity.lastWeeklyDigestAt).toISOString() : 'never'}`);
    if (!decision.due) {
      debug('light', `holding ${entity.domain} — reason: ${decision.reason} (${decision.detail})`);
      continue;
    }
    due++;
    debug('light', `due ${entity.domain} — reason: ${decision.reason} (${decision.detail})`);

    let stats;
    try {
      stats = await collectWeekStats(entity.domain, since, until);
    } catch (err) {
      console.error(`[WeeklyDigest] Stats failed for ${entity.domain}:`, err.message);
      continue;
    }

    const body = renderWeeklyDigestBody(entity.name, stats, { since, until });
    if (!body) {
      // No email AND no stamp: nothing happened, so next week's tick is the
      // first one that can report anything. Consequence of the catch-up arm,
      // deliberately accepted: an entity that has been quiet since its last
      // send re-arms catch-up every hour once the window has passed, so it
      // logs this pair hourly and sends the moment real activity appears —
      // at that hour, not at the slot. A week with nothing in it is the one
      // case where "no stamp" cannot mean "the period was handled".
      debug('light', `skipped ${entity.domain} — reason: zero-activity (nothing between ${since.toISOString()} and ${until.toISOString()})`);
      continue;
    }

    const updated = await Entity.findOneAndUpdate(
      { domain: entity.domain, lastWeeklyDigestAt: entity.lastWeeklyDigestAt ?? null },
      { $set: { lastWeeklyDigestAt: new Date(now) } }
    );
    if (!updated) {
      debug('light', `skipped ${entity.domain} — reason: stamp-race (lastWeeklyDigestAt moved under us, another tick is sending this week)`);
      continue;
    }

    debug('light', `sending to ${entity.ownerEmail} for ${entity.domain} — reason: ${decision.reason}, source: entity.weeklyDigest (dayOfWeek ${cfg.dayOfWeek ?? 1}, hour ${cfg.hour ?? 13} UTC), window ${since.toISOString()} to ${until.toISOString()}, ${stats.visitorMessages} visitor message(s), ${stats.handoffs} handoff(s) from conversation.handoffLog (${stats.handoffsFromLegacyPending} of them only in pendingQuestions, pre-handoffLog conversations)`);
    try {
      await sendEmailRaw(entity.ownerEmail, `What Leo did for ${entity.name} this week`, body);
      sent++;
    } catch (err) {
      console.error(`[WeeklyDigest] Send failed for ${entity.domain}:`, err.message);
    }
  }

  debug('normal', `tick at ${new Date(now).toISOString()}: ${entities.length} enabled, ${due} due, ${sent} sent`);
  return sent;
}

module.exports = {
  runWeeklyDigestTick,
  collectWeekStats,
  // pure, exported for the tests
  weeklyDigestDue,
  weeklyDigestDecision,
  summarizeWeek,
  renderWeeklyDigestBody,
  inWindow,
  handoffKey,
  MIN_GAP_MS,
  CATCHUP_MS,
  WEEK_MS,
  TOP_QUESTION_LIMIT,
};
