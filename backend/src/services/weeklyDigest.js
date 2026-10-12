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
// Debug tiers — WEEKLY_DIGEST_LOG_LEVEL = off | light | normal | verbose:
//   light (default) one line per actual send, naming what scheduled it
//   normal          adds the ticks that sent nothing (why they skipped)
//   verbose         adds every enabled entity considered, due or not
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

/**
 * Is this entity's weekly digest due right now? Same shape as digestDue in
 * unansweredDigest.js: schedule match on UTC weekday and UTC hour, plus an
 * elapsed-time guard against the last send.
 *
 * `entity` needs weeklyDigest ({ enabled, dayOfWeek, hour }),
 * lastWeeklyDigestAt, and ownerEmail — with no address there is nowhere to
 * send, so it is never due.
 */
function weeklyDigestDue(entity, now = Date.now()) {
  const cfg = entity?.weeklyDigest || {};
  if (!cfg.enabled) return false;
  if (!entity?.ownerEmail) return false;

  const at = new Date(now);
  if (at.getUTCHours() !== (cfg.hour ?? 13)) return false;
  if (at.getUTCDay() !== (cfg.dayOfWeek ?? 1)) return false;

  const last = entity.lastWeeklyDigestAt;
  if (!last) return true;
  const t = new Date(last).getTime();
  if (!Number.isFinite(t)) return true; // unreadable stamp: treat as never sent
  return now - t >= MIN_GAP_MS;
}

// Half-open [since, until): the instant a window ends is the next window's
// first instant, so a message on the boundary is counted exactly once.
function inWindow(at, since, until) {
  const t = new Date(at ?? NaN).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= new Date(since).getTime() && t < new Date(until).getTime();
}

/**
 * Roll a week of conversation documents into the numbers the digest reports.
 * Pure — the caller does the fetching.
 *
 * `conversations` are lean Conversation docs (messages, pendingQuestions,
 * handoffPending, createdAt). `unansweredCount` is the count of
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

    for (const q of convo.pendingQuestions || []) {
      if (inWindow(q?.askedAt, since, until)) stats.handoffs++;
    }
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
    .select('messages pendingQuestions handoffPending createdAt isTest')
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

  for (const entity of entities) {
    const cfg = entity.weeklyDigest || {};
    if (!weeklyDigestDue(entity, now)) {
      debug('verbose', `not due: ${entity.domain} — source: entity.weeklyDigest (dayOfWeek ${cfg.dayOfWeek ?? 1}, hour ${cfg.hour ?? 13} UTC), last sent ${entity.lastWeeklyDigestAt ? new Date(entity.lastWeeklyDigestAt).toISOString() : 'never'}`);
      continue;
    }

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
      // first one that can report anything.
      debug('normal', `skipped ${entity.domain} — source: zero activity between ${since.toISOString()} and ${until.toISOString()}`);
      continue;
    }

    const updated = await Entity.findOneAndUpdate(
      { domain: entity.domain, lastWeeklyDigestAt: entity.lastWeeklyDigestAt ?? null },
      { $set: { lastWeeklyDigestAt: new Date(now) } }
    );
    if (!updated) {
      debug('normal', `skipped ${entity.domain} — source: lastWeeklyDigestAt moved under us, another tick is sending this week`);
      continue;
    }

    debug('light', `sending to ${entity.ownerEmail} for ${entity.domain} — source: entity.weeklyDigest (dayOfWeek ${cfg.dayOfWeek ?? 1}, hour ${cfg.hour ?? 13} UTC), window ${since.toISOString()} to ${until.toISOString()}, ${stats.visitorMessages} visitor message(s)`);
    try {
      await sendEmailRaw(entity.ownerEmail, `What Leo did for ${entity.name} this week`, body);
      sent++;
    } catch (err) {
      console.error(`[WeeklyDigest] Send failed for ${entity.domain}:`, err.message);
    }
  }

  return sent;
}

module.exports = {
  runWeeklyDigestTick,
  collectWeekStats,
  // pure, exported for the tests
  weeklyDigestDue,
  summarizeWeek,
  renderWeeklyDigestBody,
  inWindow,
  MIN_GAP_MS,
  WEEK_MS,
  TOP_QUESTION_LIMIT,
};
