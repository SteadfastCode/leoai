// Weekly "what Leo did" owner digest (LEO-042). DEFAULT OFF — no entity
// receives one until weeklyDigest.enabled is set on it, and the Settings
// toggle ships off for every existing entity.
//
// Deliberately mirrors unansweredDigest.js: same UTC schedule shape, same
// elapsed-time guard, same atomic last-sent stamp. `weeklyDigestDue`,
// `summarizeConversations` and `renderWeeklyDigestBody` are pure (no DB, no
// network) so the due calculation, the counting and the zero-activity
// suppression are unit-testable directly.

const Entity = require('../models/Entity');
const Conversation = require('../models/Conversation');
const UnansweredQuestion = require('../models/UnansweredQuestion');
const { shapeTopQuestions } = require('./analytics');
const { sendEmailRaw } = require('./email');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Under the nominal 7 days for the same reason unansweredDigest's guard is:
// a tick landing a little early (clock skew) still sends, while a second fire
// inside the same week can never double-send. The schedule is UTC end to end,
// so a local DST transition — a 23- or 25-hour civil day — never moves the
// send hour and never lands two fires in one week.
const WEEKLY_MIN_GAP_MS = 6 * 24 * 60 * 60 * 1000;

const TOP_QUESTION_LIMIT = 5;

// Tiered debug logging: off | light | normal | verbose (default light).
// This runs unattended on a cron tick, so the light tier states the SOURCE of
// each decision — which gate rejected an entity, where a count came from —
// not just the resulting value.
const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };
function tier() {
  return TIERS[String(process.env.WEEKLY_DIGEST_DEBUG || 'light').toLowerCase()] ?? TIERS.light;
}
function dbg(level, message) {
  if (tier() >= TIERS[level]) console.log(`[WeeklyDigest] ${message}`);
}

/**
 * Is this entity's weekly digest due right now? Schedule match on UTC weekday
 * and UTC hour, plus an elapsed-time guard against the last send.
 *
 * `entity` needs weeklyDigest ({ enabled, hourUtc, dayOfWeek }),
 * lastWeeklyDigestAt, and ownerEmail.
 */
function weeklyDigestDue(entity, now = Date.now()) {
  const cfg = entity.weeklyDigest || {};
  if (!cfg.enabled) return false;
  if (!entity.ownerEmail) return false;

  const at = new Date(now);
  if (at.getUTCDay() !== (cfg.dayOfWeek ?? 1)) return false;
  if (at.getUTCHours() !== (cfg.hourUtc ?? 14)) return false;

  const last = entity.lastWeeklyDigestAt;
  if (!last) return true;
  return now - new Date(last).getTime() >= WEEKLY_MIN_GAP_MS;
}

/**
 * Fold lean Conversation docs into the counts the digest reports, restricted
 * to messages timestamped inside the window. Pure — the caller does the query.
 *
 * A conversation is counted as a handoff when it was escalated to the owner
 * inside the window (lastHandoffNotifiedAt), not merely when it is still
 * flagged pending, so a stale unanswered handoff is not re-reported weekly.
 */
function summarizeConversations(convos, since) {
  const sinceMs = new Date(since).getTime();
  let messages = 0;
  let handoffs = 0;
  const questions = [];

  for (const convo of convos || []) {
    for (const msg of convo.messages || []) {
      const at = new Date(msg.timestamp).getTime();
      if (!(at >= sinceMs)) continue;
      if (msg.role === 'assistant') messages++;
      else if (msg.role === 'user' && typeof msg.content === 'string') {
        questions.push({ text: msg.content, askedAt: msg.timestamp });
      }
    }
    const notifiedAt = convo.lastHandoffNotifiedAt ? new Date(convo.lastHandoffNotifiedAt).getTime() : 0;
    if (notifiedAt >= sinceMs) handoffs++;
  }

  return { messages, handoffs, questions };
}

/**
 * Plain-text digest body, or null when the entity had no activity at all —
 * a quiet week must suppress the email entirely, not send a "0 messages" note
 * that reads like a bill for nothing.
 */
function renderWeeklyDigestBody(entityName, stats = {}) {
  const messages = stats.messages || 0;
  const handoffs = stats.handoffs || 0;
  const unanswered = stats.unanswered || 0;
  const topQuestions = stats.topQuestions || [];

  if (messages === 0 && handoffs === 0 && unanswered === 0 && topQuestions.length === 0) return null;

  const counters = [];
  if (messages > 0) counters.push(`  ${messages} message${messages === 1 ? '' : 's'} answered`);
  if (handoffs > 0) counters.push(`  ${handoffs} conversation${handoffs === 1 ? '' : 's'} passed to you`);
  if (unanswered > 0) counters.push(`  ${unanswered} question${unanswered === 1 ? '' : 's'} Leo couldn't answer`);

  // Defensive ordering: most-asked first, ties broken by most recent. The
  // renderer owns this contract so a caller passing raw rows still gets a
  // sensibly ordered email.
  const ranked = [...topQuestions].sort(
    (a, b) => (b.count || 0) - (a.count || 0) || new Date(b.lastAskedAt || 0) - new Date(a.lastAskedAt || 0)
  );

  const lines = [`Here's what Leo did for ${entityName} this week:`, '', ...counters];

  if (ranked.length) {
    lines.push('', 'Visitors asked most about:');
    for (const q of ranked.slice(0, TOP_QUESTION_LIMIT)) {
      lines.push(`  ${q.count}×  ${q.question}`);
    }
  }

  lines.push('', 'The full picture is on your dashboard:', 'https://leo-ai.app/#/overview', '', '— Leo');
  return lines.join('\n');
}

/**
 * One pass over digest-enabled entities. Runs beside the LeoRefresh hourly
 * tick. Skips silently when an entity had zero activity, and stamps
 * lastWeeklyDigestAt atomically (matched on its previous value, the same
 * pattern the unanswered digest and handoff follow-up use) so concurrent
 * ticks can never double-send.
 */
async function runWeeklyDigestTick(now = Date.now()) {
  const entities = await Entity.find({ 'weeklyDigest.enabled': true }).lean();
  dbg('normal', `tick: ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'} with weeklyDigest.enabled`);

  for (const entity of entities) {
    if (!weeklyDigestDue(entity, now)) {
      dbg('verbose', `${entity.domain}: not due (source: schedule/guard mismatch, lastWeeklyDigestAt=${entity.lastWeeklyDigestAt || 'never'})`);
      continue;
    }

    const since = new Date(now - WEEK_MS);
    const convos = await Conversation.find({
      domain: entity.domain,
      isTest: { $ne: true },
      lastActiveAt: { $gte: since },
    })
      .select('messages lastHandoffNotifiedAt')
      .lean();

    const { messages, handoffs, questions } = summarizeConversations(convos, since);
    const unanswered = await UnansweredQuestion.countDocuments({
      entityDomain: entity.domain,
      addedToKb: false,
      resolvedByReply: { $ne: true },
      createdAt: { $gte: since },
    });

    const body = renderWeeklyDigestBody(entity.name, {
      messages,
      handoffs,
      unanswered,
      topQuestions: shapeTopQuestions(questions, TOP_QUESTION_LIMIT),
    });

    if (!body) {
      // Zero activity: no email, no stamp — nothing happened, so the next
      // due week starts from the same clean slate.
      dbg('light', `${entity.domain}: suppressed (source: zero activity in the 7 days since ${since.toISOString()})`);
      continue;
    }

    const updated = await Entity.findOneAndUpdate(
      { domain: entity.domain, lastWeeklyDigestAt: entity.lastWeeklyDigestAt ?? null },
      { $set: { lastWeeklyDigestAt: new Date(now) } }
    );
    if (!updated) {
      dbg('light', `${entity.domain}: skipped (source: lastWeeklyDigestAt changed under us — another tick already sent)`);
      continue;
    }

    dbg('light', `${entity.domain}: sending (source: ${convos.length} active conversations → ${messages} messages, ${handoffs} handoffs, ${unanswered} unanswered)`);
    try {
      await sendEmailRaw(entity.ownerEmail, `What Leo did for ${entity.name} this week`, body);
    } catch (err) {
      console.error(`[WeeklyDigest] Send failed for ${entity.domain}:`, err.message);
    }
  }
}

module.exports = {
  weeklyDigestDue,
  summarizeConversations,
  renderWeeklyDigestBody,
  runWeeklyDigestTick,
  WEEKLY_MIN_GAP_MS,
  WEEK_MS,
  TOP_QUESTION_LIMIT,
};
