// Visitor "forget me" + per-entity conversation retention (LEO-043).
//
// Two destructive paths, both deliberately narrow:
//   1. forgetConversation — a visitor erasing their OWN transcript. Scoped to
//      the exact domain + sessionToken pair the caller presented; a mismatch
//      on either half deletes nothing. There is no bulk form of this call.
//   2. runRetentionSweepTick — the owner-configured age sweep. Dormant unless
//      an entity sets conversationRetentionDays > 0 (default 0 = keep forever),
//      and then scoped to that one entity's domain, and never touching a
//      conversation whose handoff the owner has not answered yet.
//
// BOTH paths delete from TWO collections (LEO-099). An UnansweredQuestion row
// stores `question` — the visitor's message VERBATIM — beside their
// sessionToken and conversationId, and it has no expiry of its own. Deleting
// only the Conversation left those words on the owner's Unanswered page and in
// the weekly digest's "most asked" list forever, while the widget's consent
// screen promised "Delete it everywhere". The promise is the specification, so
// the deletes follow it:
//   * forget — every row matching entityDomain + sessionToken, whatever its
//     age and whether or not the owner has already triaged it.
//   * sweep — only rows belonging to the conversation ids this tick actually
//     deleted, collected BEFORE the delete. A row whose conversation outlived
//     the cutoff is never taken as collateral.
// One thing deliberately survives both: the `unanswered_qa` Chunk an owner has
// already added to their knowledge base. That text is the business's own KB
// content now, answering future visitors, and is not keyed to a session.
//
// The sweep's own schedule has a CATCH-UP arm (LEO-084). It used to open with
// a bare `getUTCHours() !== SWEEP_HOUR_UTC` return and kept no last-run stamp
// anywhere, so it could not tell a missed hour from a completed one. One
// `cron.schedule('0 * * * *')` fire is the only thing that ever calls it, and
// Railway redeploys on every merge — so losing the 05:00 fire was ordinary,
// and the cost was a WHOLE DAY of deletions never happening for an owner who
// had opted into a retention window. For a privacy feature, quietly not
// deleting is the failure that matters. The hour gate is therefore per-entity
// now, through `sweepDue`: due at SWEEP_HOUR_UTC, or when
// entity.retentionLastSweepAt is older than a catch-up window, and never
// inside the elapsed-gap guard that makes a second sweep in the same day
// pointless work. The window is deliberately past the period, so a missed
// 05:00 sweep is recovered by the 07:00 tick — two hours late, rather than a
// whole day of deletions never happening.
//
// An entity that has NEVER been swept is not caught up — it has missed
// nothing. It waits for the sweep hour, so switching retention on never
// deletes anything in the same minute.
//
// retentionCutoff / conversationExpired / forgetFilter / sweepFilter /
// unansweredForgetFilter / unansweredSweepFilter / sweepDue are pure (no DB, no
// clock of their own) so the age arithmetic and — the part that actually
// matters — the shape of the delete filters can be asserted without a
// database. A widened filter here is a data-loss bug, so the filter builders
// return null rather than an empty object whenever an input is unusable: a
// `{}` filter passed to deleteMany wipes the collection.
//
// Debug tiers — RETENTION_LOG_LEVEL = off | light | normal | verbose:
//   light (default) one line per actual deletion, naming the COLLECTION it came
//                   from and what caused it, plus one line per sweep decision
//                   naming the REASON it was taken or held — hour match,
//                   catch-up after N hours, gap guard, retention disabled
//   normal          adds the decisions that deleted nothing (why it skipped)
//                   and the tick-level counts
//   verbose         adds per-conversation ages, session tokens truncated, and
//                   the raw last-sweep stamp each decision read
// Both paths run away from a human (a cron tick, a widget menu tap), so the
// light tier always says the SOURCE of a deletion, not just the count.

const Conversation = require('../models/Conversation');
const Entity = require('../models/Entity');
const UnansweredQuestion = require('../models/UnansweredQuestion');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The sweep rides the hourly LeoRefresh tick but is a DAILY job: it aims at
// this UTC hour. Deliberately clear of 3 AM UTC (the default LeoRefresh hour)
// so a long rescrape and a delete pass never contend.
const SWEEP_HOUR_UTC = 5;

// Elapsed-time guard, deliberately under the nominal day so a tick landing a
// little early (clock skew) still sweeps, while a replayed fire inside the same
// hour — or a catch-up immediately after a real sweep — is always inside the
// guard. A second sweep in one day deletes nothing new; it is wasted work and a
// misleading log line, not a data risk.
const SWEEP_MIN_GAP_MS = 20 * HOUR_MS;

// How stale retentionLastSweepAt must be before a tick in ANY hour takes the
// sweep, because the 05:00 slot was evidently missed. Set past the period (26h)
// so a healthy entity is always claimed by its own hour first and the catch-up
// arm only ever fires after something actually went wrong.
const SWEEP_CATCHUP_MS = 26 * HOUR_MS;

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.RETENTION_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[Retention] ${message}`);
}

// A session token is the key to a visitor's whole transcript — never log one
// in full, not even at verbose.
function shortToken(token) {
  const t = String(token || '');
  return t.length > 10 ? `${t.slice(0, 10)}…` : t;
}

/**
 * Configured retention in whole days, or 0 when retention is off. Absent,
 * zero, negative and junk values all mean "keep forever" — the setting may
 * never fail open into deleting something.
 */
function retentionDays(entity) {
  const raw = Number(entity?.conversationRetentionDays);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw;
}

/**
 * The instant a conversation must be older than to be swept, or null when
 * retention is disabled for this entity.
 */
function retentionCutoff(entity, now = Date.now()) {
  const days = retentionDays(entity);
  if (!days) return null;
  return new Date(new Date(now).getTime() - days * DAY_MS);
}

// Age is measured from the LAST activity, not from creation: a conversation
// opened months ago but used this morning is live, and deleting it mid-chat
// would be the rudest possible reading of a retention setting.
function lastActivityAt(conversation) {
  return conversation?.lastActiveAt || conversation?.updatedAt || conversation?.createdAt || null;
}

/**
 * Is this conversation past the entity's retention window? Mirrors sweepFilter
 * exactly — strictly older than the cutoff, so a conversation that is exactly
 * N days old survives one more tick.
 */
function conversationExpired(conversation, entity, now = Date.now()) {
  const cutoff = retentionCutoff(entity, now);
  if (!cutoff) return false; // retention off
  // An unresolved handoff is a question the owner still owes a visitor an
  // answer to. Ageing that out silently would lose the question and the only
  // way back to the person who asked it, so retention waits for the reply.
  // (A visitor's own "forget me" is NOT held back by this — see forgetFilter.)
  if (conversation?.handoffPending === true) return false;
  const last = lastActivityAt(conversation);
  if (!last) return false; // no timestamp at all: never expire on a guess
  const at = new Date(last).getTime();
  if (!Number.isFinite(at)) return false;
  return at < cutoff.getTime();
}

/**
 * Delete filter for one visitor erasing their own transcript: the exact
 * domain + sessionToken pair, nothing broader. Returns null when either half
 * is missing or not a string, so a malformed request can never become a filter
 * that matches more than one conversation.
 */
function forgetFilter({ domain, sessionToken } = {}) {
  if (typeof domain !== 'string' || typeof sessionToken !== 'string') return null;
  const d = domain.trim();
  const t = sessionToken.trim();
  if (!d || !t) return null;
  return { domain: d, sessionToken: t };
}

/**
 * Delete filter for the age sweep, scoped to one domain. The $or covers
 * documents written before lastActiveAt existed — they fall back to createdAt
 * rather than being treated as infinitely old. Conversations with an
 * unresolved handoff are excluded, the same exemption conversationExpired
 * makes.
 */
function sweepFilter(domain, cutoff) {
  if (typeof domain !== 'string' || !domain.trim()) return null;
  if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) return null;
  return {
    domain: domain.trim(),
    handoffPending: { $ne: true }, // mirrors conversationExpired
    $or: [
      { lastActiveAt: { $lt: cutoff } },
      { lastActiveAt: { $exists: false }, createdAt: { $lt: cutoff } },
    ],
  };
}

/**
 * Delete filter for the UnansweredQuestion rows belonging to one visitor on one
 * site. Same discipline as forgetFilter — null, never `{}`, for anything
 * unusable — against a different field name: the log calls the domain
 * `entityDomain`.
 *
 * Deliberately NOT narrowed any further than the pair. An already-triaged row
 * (addedToKb, resolvedByReply) still holds the visitor's own words, and the
 * consent screen's promise does not have an exception for one the owner has
 * read. What the owner keeps is the KB chunk, which is not in this collection.
 */
function unansweredForgetFilter({ domain, sessionToken } = {}) {
  if (typeof domain !== 'string' || typeof sessionToken !== 'string') return null;
  const d = domain.trim();
  const t = sessionToken.trim();
  if (!d || !t) return null;
  return { entityDomain: d, sessionToken: t };
}

// An id is usable only as a real ObjectId or a 24-hex string. Note that
// mongoose's own isValid() is NOT the test to use here: it accepts ANY 12-char
// string, so a domain like 'a.example.co' passes it and would be cast into a
// filter matching a document nobody asked about.
function usableConversationId(id) {
  if (id && typeof id.toHexString === 'function') return id;
  if (typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id.trim())) return id.trim();
  return null;
}

/**
 * Delete filter for the UnansweredQuestion rows of conversations the age sweep
 * has just deleted. Keyed ONLY on conversationId — those are globally unique,
 * so the ids are already the whole scope — and built from ids collected before
 * the delete, so a conversation that aged past the cutoff mid-tick cannot drag
 * a surviving visitor's rows out with it.
 *
 * Returns null for an empty list, a non-array, or a list with no usable id in
 * it. `{ conversationId: { $in: [] } }` matches nothing rather than
 * everything, but null is what the caller can actually assert on, and it keeps
 * every builder in this file to the one rule: unusable input, no filter.
 */
function unansweredSweepFilter(conversationIds) {
  if (!Array.isArray(conversationIds) || !conversationIds.length) return null;
  const ids = conversationIds.map(usableConversationId).filter(Boolean);
  if (!ids.length) return null;
  return { conversationId: { $in: ids } };
}

// Gaps here are hours-to-days, so one rounded unit is the readable form.
function formatGap(ms) {
  const hours = ms / HOUR_MS;
  if (hours < 48) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

function formatHour(hour) {
  return `${String(hour).padStart(2, '0')}:00 UTC`;
}

// null means "never swept" — which includes an unreadable stamp: a decision
// made from a NaN compares false against every window and would wedge the
// entity out of the schedule entirely, which for a retention setting means
// never deleting anything again.
function lastSweepMs(entity) {
  const raw = entity?.retentionLastSweepAt;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Why this entity's retention sweep is (or is not) due right now:
 * `{ due, reason, detail }`. Pure — `now` is injected, nothing is read from the
 * DB. `reason` is a stable slug for logs and tests; `detail` is the human half
 * of the light-tier line.
 *
 * `entity` needs conversationRetentionDays and retentionLastSweepAt. Retention
 * off means never due: the setting may not fail open into deleting something.
 */
function sweepDecision(entity, now = Date.now()) {
  const days = retentionDays(entity);
  if (!days) {
    return { due: false, reason: 'disabled', detail: 'conversationRetentionDays is 0 — conversations are kept forever' };
  }

  const onSchedule = new Date(now).getUTCHours() === SWEEP_HOUR_UTC;
  const last = lastSweepMs(entity);

  if (last === null) {
    return onSchedule
      ? { due: true, reason: 'first-run', detail: `never swept, and ${formatHour(SWEEP_HOUR_UTC)} is the sweep hour` }
      : { due: false, reason: 'awaiting-first-slot', detail: `never swept; holding for ${formatHour(SWEEP_HOUR_UTC)}` };
  }

  const elapsed = now - last;
  if (elapsed < 0) {
    return { due: false, reason: 'future-stamp', detail: `last sweep is stamped ${formatGap(-elapsed)} in the future (clock skew) — holding off` };
  }
  if (elapsed < SWEEP_MIN_GAP_MS) {
    return { due: false, reason: 'gap-guard', detail: `last swept ${formatGap(elapsed)} ago, inside the ${formatGap(SWEEP_MIN_GAP_MS)} gap guard` };
  }
  if (onSchedule) {
    return { due: true, reason: 'hour-match', detail: `${formatHour(SWEEP_HOUR_UTC)} is the sweep hour; last swept ${formatGap(elapsed)} ago` };
  }
  if (elapsed >= SWEEP_CATCHUP_MS) {
    return { due: true, reason: 'catch-up', detail: `catch-up after ${formatGap(elapsed)} — the ${formatHour(SWEEP_HOUR_UTC)} sweep was missed and the ${formatGap(SWEEP_CATCHUP_MS)} window has passed` };
  }
  return { due: false, reason: 'off-schedule', detail: `now is not ${formatHour(SWEEP_HOUR_UTC)}, and last swept ${formatGap(elapsed)} ago is inside the ${formatGap(SWEEP_CATCHUP_MS)} catch-up window` };
}

/** Boolean half of sweepDecision. `now` is injected so this stays testable. */
function sweepDue(entity, now = Date.now()) {
  return sweepDecision(entity, now).due;
}

/**
 * Erase everything this caller's session left on the server: their transcript
 * and the UnansweredQuestion rows holding their questions verbatim. Returns
 * the two counts separately — `{ conversations, questions }` — because they are
 * different collections and a caller reporting "nothing was deleted" should
 * only say so when both are 0. Never throws for a bad argument; an unusable
 * pair simply deletes nothing.
 *
 * The two deletes are independent: there is no transaction, and the question
 * rows go second. A failure between them leaves the transcript gone and the
 * rows behind, which the visitor can retry — the endpoint is idempotent — and
 * which is strictly better than the reverse order, where a visitor whose
 * transcript survived would be told their history was cleared.
 */
async function forgetConversation({ domain, sessionToken } = {}) {
  const filter = forgetFilter({ domain, sessionToken });
  const questionFilter = unansweredForgetFilter({ domain, sessionToken });
  if (!filter || !questionFilter) {
    debug('normal', 'forget: refused an unusable domain/sessionToken pair — source: POST /chat/forget');
    return { conversations: 0, questions: 0 };
  }

  const { deletedCount } = await Conversation.deleteMany(filter);
  if (deletedCount) {
    debug('light', `forget: deleted ${deletedCount} from conversations for ${filter.domain} — source: POST /chat/forget by visitor session ${shortToken(filter.sessionToken)}`);
  } else {
    debug('normal', `forget: nothing matched ${filter.domain} / ${shortToken(filter.sessionToken)} in conversations — source: POST /chat/forget (already cleared, or a token from another device)`);
  }

  const { deletedCount: questions } = await UnansweredQuestion.deleteMany(questionFilter);
  if (questions) {
    debug('light', `forget: deleted ${questions} from unansweredquestions for ${questionFilter.entityDomain} — source: POST /chat/forget by visitor session ${shortToken(questionFilter.sessionToken)} (their questions, stored verbatim)`);
  } else {
    debug('normal', `forget: nothing matched ${questionFilter.entityDomain} / ${shortToken(questionFilter.sessionToken)} in unansweredquestions — source: POST /chat/forget (Leo answered everything they asked, or the rows are already gone)`);
  }

  return { conversations: deletedCount, questions };
}

/**
 * One daily pass over entities with retention enabled. The hour gate is
 * per-entity (`sweepDue`) rather than a single early return, so a tick that
 * missed 05:00 UTC can still take the sweep later the same morning — see the
 * catch-up note at the top of this file. The cost of moving the gate inward is
 * one indexed `find` per hour instead of one per day, which at this scale is
 * nothing.
 *
 * Returns the total deleted. Per-entity failures are logged and skipped — one
 * bad domain must not stop the rest.
 */
async function runRetentionSweepTick(now = Date.now()) {
  const entities = await Entity.find({ conversationRetentionDays: { $gt: 0 } })
    .select('domain conversationRetentionDays retentionLastSweepAt')
    .lean();

  if (!entities.length) {
    debug('normal', 'sweep: no entity has conversationRetentionDays set — nothing to do');
    return 0;
  }

  let total = 0;
  let swept = 0;
  for (const entity of entities) {
    const days = retentionDays(entity);
    const decision = sweepDecision(entity, now);
    debug('verbose', `sweep: ${entity.domain} read conversationRetentionDays=${entity.conversationRetentionDays}, retentionLastSweepAt ${entity.retentionLastSweepAt ? new Date(entity.retentionLastSweepAt).toISOString() : 'never'}`);
    if (!decision.due) {
      debug('light', `sweep: holding ${entity.domain} — reason: ${decision.reason} (${decision.detail})`);
      continue;
    }

    const cutoff = retentionCutoff(entity, now);
    const filter = sweepFilter(entity.domain, cutoff);
    if (!filter) {
      debug('normal', `sweep: skipped ${entity.domain} — source: unusable domain or cutoff (conversationRetentionDays=${entity.conversationRetentionDays})`);
      continue;
    }

    // Claim the day before deleting, matched on the stamp this decision read —
    // the same atomic test-and-set the two digests use. Two overlapping ticks
    // therefore produce exactly one sweep, and a second call in the same hour
    // lands in the gap guard above. Claiming first means a sweep whose
    // deleteMany then fails is retried at the next day's hour rather than
    // immediately; the conversations are still past the cutoff, so nothing is
    // lost, which is the same thing that happened before this stamp existed.
    const claimed = await Entity.findOneAndUpdate(
      { domain: entity.domain, retentionLastSweepAt: entity.retentionLastSweepAt ?? null },
      { $set: { retentionLastSweepAt: new Date(now) } }
    );
    if (!claimed) {
      debug('light', `sweep: skipped ${entity.domain} — reason: stamp-race (retentionLastSweepAt moved under us, another tick is sweeping)`);
      continue;
    }
    swept++;
    debug('light', `sweep: running ${entity.domain} — reason: ${decision.reason} (${decision.detail})`);

    try {
      // Read the doomed set BEFORE deleting it: once the conversations are
      // gone there is no way back from an UnansweredQuestion row to the
      // cutoff that condemned it, and matching those rows on anything broader
      // than "the ids this tick took" would reach a live visitor's questions.
      const doomed = await Conversation.find(filter).select('sessionToken lastActiveAt createdAt').lean();
      if (logTier() >= TIERS.verbose) {
        for (const c of doomed) {
          debug('verbose', `sweep: ${entity.domain} / ${shortToken(c.sessionToken)} last active ${new Date(lastActivityAt(c)).toISOString()} — older than cutoff ${cutoff.toISOString()}`);
        }
      }

      const { deletedCount } = await Conversation.deleteMany(filter);
      total += deletedCount;
      if (deletedCount) {
        debug('light', `sweep: deleted ${deletedCount} from conversations for ${entity.domain} — source: entity.conversationRetentionDays=${days}, cutoff ${cutoff.toISOString()} (unanswered handoffs exempt)`);
      } else {
        debug('normal', `sweep: nothing older than ${cutoff.toISOString()} for ${entity.domain} — source: entity.conversationRetentionDays=${days}`);
      }

      const questionFilter = unansweredSweepFilter(doomed.map((c) => c._id));
      if (questionFilter) {
        const { deletedCount: questions } = await UnansweredQuestion.deleteMany(questionFilter);
        if (questions) {
          debug('light', `sweep: deleted ${questions} from unansweredquestions for ${entity.domain} — source: ${doomed.length} swept conversation id(s), cutoff ${cutoff.toISOString()}`);
        } else {
          debug('normal', `sweep: no unansweredquestions rows belonged to the ${doomed.length} conversation(s) swept for ${entity.domain}`);
        }
      }
    } catch (err) {
      console.error(`[Retention] sweep failed for ${entity.domain}:`, err.message);
    }
  }
  debug('normal', `sweep: tick at ${new Date(now).toISOString()} — ${entities.length} entity/entities with retention on, ${swept} swept, ${total} conversation(s) deleted`);
  return total;
}

module.exports = {
  forgetConversation,
  runRetentionSweepTick,
  // pure, exported for the tests
  retentionDays,
  retentionCutoff,
  conversationExpired,
  forgetFilter,
  sweepFilter,
  unansweredForgetFilter,
  unansweredSweepFilter,
  sweepDue,
  sweepDecision,
  lastActivityAt,
  SWEEP_HOUR_UTC,
  SWEEP_MIN_GAP_MS,
  SWEEP_CATCHUP_MS,
  HOUR_MS,
  DAY_MS,
};
