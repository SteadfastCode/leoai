// Unanswered-questions email digest (LEO-026). DEFAULT OFF — no entity
// receives one until unansweredDigest.enabled is set on it, and there is no
// self-service UI for that yet.
//
// `digestDue` and `renderDigestBody` are pure (no DB, no network) so the due
// calculation and empty-list suppression are unit-testable directly.
//
// The due calculation has a CATCH-UP arm (LEO-084). One
// `cron.schedule('0 * * * *')` fire is the only thing that ever calls this, and
// the predicate used to require an exact UTC hour (plus weekday when weekly).
// Miss that single fire — a container restart spanning the hour, and Railway
// redeploys on every merge — and a `daily` sender waited another 24 hours, a
// `weekly` one another 7 days, silently. So the predicate is now due when the
// scheduled hour (and weekday) match, OR when unansweredDigestLastSentAt is
// older than a catch-up window, and never inside the elapsed-gap guard that
// makes a second send in the same period impossible. Same shape as
// refreshDecision in leoRefresh.js and weeklyDigestDecision in weeklyDigest.js.
//
// An entity that has NEVER sent is not caught up — it has missed nothing, and
// a digest the instant the toggle flips is not what the hour setting means. It
// waits for its scheduled slot.
//
// Debug tiers — UNANSWERED_DIGEST_LOG_LEVEL = off | light | normal | verbose:
//   light (default) one line per entity decision, naming the REASON it was
//                   taken or held — slot match, catch-up after N hours, gap
//                   guard, disabled — plus every post-due outcome (the send,
//                   an empty list, a stamp that moved under us)
//   normal          adds the tick-level counts
//   verbose         adds the raw schedule + last-send stamp each decision read
// This runs away from a human (an hourly cron tick), so the light tier always
// says the SOURCE of a send, not just that mail went out.

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

// How stale unansweredDigestLastSentAt must be before a tick in ANY hour takes
// the send, because the scheduled slot was evidently missed. Set past the
// period (26h / 8d) so a healthy entity is always claimed by its own slot
// first and the catch-up arm only ever fires after something actually went
// wrong.
//
// Consequence, deliberately accepted: a caught-up digest goes out OUTSIDE the
// owner's chosen hour, once, and a run of back-to-back misses drifts by the
// difference between the catch-up window and the period until the scheduled
// hour comes back within reach. Roughly-on-time beats silently skipped;
// sending the same period twice is what the gap guard will not allow.
const DAILY_CATCHUP_MS = 26 * 60 * 60 * 1000;
const WEEKLY_CATCHUP_MS = 8 * 24 * 60 * 60 * 1000;

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.UNANSWERED_DIGEST_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[UnansweredDigest] ${message}`);
}

// Gaps here are hours-to-days, so one rounded unit is the readable form.
function formatGap(ms) {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 48) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatSlot(hourUtc, dayOfWeek) {
  const hour = `${String(hourUtc).padStart(2, '0')}:00 UTC`;
  if (dayOfWeek === null) return `daily ${hour}`;
  return `${DAY_NAMES[dayOfWeek] || `day ${dayOfWeek}`} ${hour}`;
}

// null means "never sent" — which includes an unreadable stamp: a decision made
// from a NaN compares false against every window and would wedge the entity out
// of the schedule entirely, the exact failure this catch-up arm exists to fix.
function lastSentMs(entity) {
  const raw = entity?.unansweredDigestLastSentAt;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Why this entity's digest is (or is not) due right now:
 * `{ due, reason, detail }`. Mirrors refreshDecision in leoRefresh.js —
 * schedule match on UTC hour (and UTC weekday for weekly), an elapsed-gap
 * guard against the last send, and a catch-up arm for a missed slot. Pure:
 * `now` is injected, nothing is read from the DB. `reason` is a stable slug for
 * logs and tests; `detail` is the human half of the light-tier line.
 *
 * `entity` needs unansweredDigest ({ enabled, frequency, hourUtc, dayOfWeek }),
 * unansweredDigestLastSentAt, and ownerEmail.
 */
function digestDecision(entity, now = Date.now()) {
  const cfg = entity?.unansweredDigest || {};
  if (!cfg.enabled) {
    return { due: false, reason: 'disabled', detail: 'the unanswered digest is off for this entity' };
  }
  if (!entity?.ownerEmail) {
    return { due: false, reason: 'no-recipient', detail: 'no ownerEmail on the entity — nowhere to send' };
  }

  const weekly = (cfg.frequency || 'weekly') === 'weekly';
  const hourUtc = cfg.hourUtc ?? 13;
  const dayOfWeek = weekly ? (cfg.dayOfWeek ?? 1) : null;
  const gapMs = weekly ? WEEKLY_MIN_GAP_MS : DAILY_MIN_GAP_MS;
  const catchUpMs = weekly ? WEEKLY_CATCHUP_MS : DAILY_CATCHUP_MS;
  const slot = formatSlot(hourUtc, dayOfWeek);

  const at = new Date(now);
  const onSchedule = at.getUTCHours() === hourUtc && (!weekly || at.getUTCDay() === dayOfWeek);
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
  if (elapsed < gapMs) {
    return { due: false, reason: 'gap-guard', detail: `last sent ${formatGap(elapsed)} ago, inside the ${formatGap(gapMs)} ${weekly ? 'weekly' : 'daily'} gap guard` };
  }
  if (onSchedule) {
    return { due: true, reason: 'slot-match', detail: `now is its ${slot} slot; last sent ${formatGap(elapsed)} ago` };
  }
  if (elapsed >= catchUpMs) {
    return { due: true, reason: 'catch-up', detail: `catch-up after ${formatGap(elapsed)} — its ${slot} slot was missed and the ${formatGap(catchUpMs)} window has passed` };
  }
  return { due: false, reason: 'off-schedule', detail: `now is not its ${slot} slot, and last sent ${formatGap(elapsed)} ago is inside the ${formatGap(catchUpMs)} catch-up window` };
}

/** Boolean half of digestDecision. `now` is injected so this stays testable. */
function digestDue(entity, now = Date.now()) {
  return digestDecision(entity, now).due;
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
  let due = 0;
  let sent = 0;

  for (const entity of entities) {
    const cfg = entity.unansweredDigest || {};
    const decision = digestDecision(entity, now);
    debug('verbose', `${entity.domain} read entity.unansweredDigest (frequency ${cfg.frequency || 'weekly'}, hourUtc ${cfg.hourUtc ?? 13}, dayOfWeek ${cfg.dayOfWeek ?? 1}), unansweredDigestLastSentAt ${entity.unansweredDigestLastSentAt ? new Date(entity.unansweredDigestLastSentAt).toISOString() : 'never'}`);
    if (!decision.due) {
      debug('light', `holding ${entity.domain} — reason: ${decision.reason} (${decision.detail})`);
      continue;
    }
    due++;
    debug('light', `due ${entity.domain} — reason: ${decision.reason} (${decision.detail})`);

    const questions = await UnansweredQuestion.find({
      entityDomain: entity.domain,
      addedToKb: false,
      resolvedByReply: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .lean();

    const body = renderDigestBody(entity.name, groupQuestions(questions));
    if (!body) {
      // Empty list: no email, no stamp — nothing happened. Consequence of the
      // catch-up arm, deliberately accepted: an entity with nothing open
      // re-arms catch-up every hour once the window has passed, so it logs
      // this pair hourly and sends the moment a question actually goes
      // unanswered — at that hour, not at the slot. A period with nothing in
      // it is the one case where "no stamp" cannot mean "the period was
      // handled".
      debug('light', `skipped ${entity.domain} — reason: empty-list (no open unanswered questions)`);
      continue;
    }

    const updated = await Entity.findOneAndUpdate(
      { domain: entity.domain, unansweredDigestLastSentAt: entity.unansweredDigestLastSentAt ?? null },
      { $set: { unansweredDigestLastSentAt: new Date(now) } }
    );
    if (!updated) {
      debug('light', `skipped ${entity.domain} — reason: stamp-race (unansweredDigestLastSentAt moved under us, another tick is sending this period)`);
      continue; // another process beat us to it
    }

    debug('light', `sending to ${entity.ownerEmail} for ${entity.domain} — reason: ${decision.reason}, source: entity.unansweredDigest (frequency ${cfg.frequency || 'weekly'}, hourUtc ${cfg.hourUtc ?? 13} UTC), ${questions.length} open question(s)`);
    try {
      await sendEmailRaw(entity.ownerEmail, `Questions Leo couldn't answer for ${entity.name}`, body);
      sent++;
    } catch (err) {
      console.error(`[UnansweredDigest] Send failed for ${entity.domain}:`, err.message);
    }
  }

  debug('normal', `tick at ${new Date(now).toISOString()}: ${entities.length} enabled, ${due} due, ${sent} sent`);
  return sent;
}

module.exports = {
  digestDue,
  digestDecision,
  renderDigestBody,
  runUnansweredDigestTick,
  DAILY_MIN_GAP_MS,
  WEEKLY_MIN_GAP_MS,
  DAILY_CATCHUP_MS,
  WEEKLY_CATCHUP_MS,
};
