// Unanswered-questions email digest (LEO-026). DEFAULT OFF — no entity
// receives one until unansweredDigest.enabled is set on it, and there is no
// self-service UI for that yet.
//
// `digestDue` and `renderDigestBody` are pure (no DB, no network) so the due
// calculation and empty-list suppression are unit-testable directly.

const Entity = require('../models/Entity');
const UnansweredQuestion = require('../models/UnansweredQuestion');
const { groupQuestions } = require('./questions');
const { sendEmailRaw } = require('./email');

// Elapsed-time guards, deliberately under the nominal period so a tick landing
// a little early (clock skew) still sends, while a DST-length day (23h local)
// can never double-send: the schedule is UTC throughout, and a second fire in
// the same period is always inside the guard.
const DAILY_MIN_GAP_MS = 20 * 60 * 60 * 1000;
const WEEKLY_MIN_GAP_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * Is this entity's digest due right now? Mirrors the isDueNow/reminderDue
 * shape: schedule match on UTC hour (and UTC weekday for weekly), plus an
 * elapsed-time guard against the last send.
 *
 * `entity` needs unansweredDigest ({ enabled, frequency, hourUtc, dayOfWeek }),
 * unansweredDigestLastSentAt, and ownerEmail.
 */
function digestDue(entity, now = Date.now()) {
  const cfg = entity.unansweredDigest || {};
  if (!cfg.enabled) return false;
  if (!entity.ownerEmail) return false;

  const at = new Date(now);
  if (at.getUTCHours() !== (cfg.hourUtc ?? 13)) return false;
  if ((cfg.frequency || 'weekly') === 'weekly' && at.getUTCDay() !== (cfg.dayOfWeek ?? 1)) return false;

  const last = entity.unansweredDigestLastSentAt;
  if (!last) return true;
  const gap = (cfg.frequency || 'weekly') === 'daily' ? DAILY_MIN_GAP_MS : WEEKLY_MIN_GAP_MS;
  return now - new Date(last).getTime() >= gap;
}

/**
 * Plain-text digest body, or null when there is nothing to say — an empty
 * question list must suppress the email entirely, not send a "0 questions"
 * note.
 */
function renderDigestBody(entityName, groups) {
  if (!groups || groups.length === 0) return null;

  const total = groups.reduce((n, g) => n + g.count, 0);
  const lines = groups.map((g) => {
    const when = new Date(g.lastAskedAt).toISOString().slice(0, 10);
    return `  ${g.count}×  ${g.question}  (last asked ${when})`;
  });

  return [
    `Visitors asked ${entityName}'s Leo ${total} question${total === 1 ? '' : 's'} he couldn't answer:`,
    '',
    ...lines,
    '',
    'Answer any of these once in your dashboard and Leo learns it for every future visitor:',
    'https://leo-ai.app/#/unanswered',
    '',
    '— Leo',
  ].join('\n');
}

/**
 * One pass over digest-enabled entities. Runs beside the LeoRefresh hourly
 * tick. Skips silently when an entity has no open unanswered questions, and
 * stamps unansweredDigestLastSentAt atomically (matched on its previous value,
 * same pattern as the handoff follow-up) so concurrent ticks can never
 * double-send.
 */
async function runUnansweredDigestTick(now = Date.now()) {
  const entities = await Entity.find({ 'unansweredDigest.enabled': true }).lean();

  for (const entity of entities) {
    if (!digestDue(entity, now)) continue;

    const questions = await UnansweredQuestion.find({
      entityDomain: entity.domain,
      addedToKb: false,
      resolvedByReply: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .lean();

    const body = renderDigestBody(entity.name, groupQuestions(questions));
    if (!body) continue; // empty list: no email, no stamp — nothing happened

    const updated = await Entity.findOneAndUpdate(
      { domain: entity.domain, unansweredDigestLastSentAt: entity.unansweredDigestLastSentAt ?? null },
      { $set: { unansweredDigestLastSentAt: new Date(now) } }
    );
    if (!updated) continue; // another process beat us to it

    console.log(`[UnansweredDigest] Sending digest for ${entity.domain}`);
    try {
      await sendEmailRaw(entity.ownerEmail, `Questions Leo couldn't answer for ${entity.name}`, body);
    } catch (err) {
      console.error(`[UnansweredDigest] Send failed for ${entity.domain}:`, err.message);
    }
  }
}

module.exports = { digestDue, renderDigestBody, runUnansweredDigestTick, DAILY_MIN_GAP_MS, WEEKLY_MIN_GAP_MS };
