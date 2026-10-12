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
// retentionCutoff / conversationExpired / forgetFilter / sweepFilter are pure
// (no DB, no clock of their own) so the age arithmetic and — the part that
// actually matters — the shape of the delete filters can be asserted without a
// database. A widened filter here is a data-loss bug, so the filter builders
// return null rather than an empty object whenever an input is unusable: a
// `{}` filter passed to deleteMany wipes the collection.
//
// Debug tiers — RETENTION_LOG_LEVEL = off | light | normal | verbose:
//   light (default) one line per actual deletion, naming what caused it
//   normal          adds the decisions that deleted nothing (why it skipped)
//   verbose         adds per-conversation ages, session tokens truncated
// Both paths run away from a human (a cron tick, a widget menu tap), so the
// light tier always says the SOURCE of a deletion, not just the count.

const Conversation = require('../models/Conversation');
const Entity = require('../models/Entity');

const DAY_MS = 24 * 60 * 60 * 1000;

// The sweep rides the hourly LeoRefresh tick but is a DAILY job: it acts in
// this UTC hour only. Deliberately clear of 3 AM UTC (the default LeoRefresh
// hour) so a long rescrape and a delete pass never contend.
const SWEEP_HOUR_UTC = 5;

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
 * Erase the caller's own conversation. Returns the number deleted (0 or 1 —
 * sessionToken+domain is unique). Never throws for a bad argument; an
 * unusable pair simply deletes nothing.
 */
async function forgetConversation({ domain, sessionToken } = {}) {
  const filter = forgetFilter({ domain, sessionToken });
  if (!filter) {
    debug('normal', 'forget: refused an unusable domain/sessionToken pair — source: POST /chat/forget');
    return 0;
  }

  const { deletedCount } = await Conversation.deleteMany(filter);
  if (deletedCount) {
    debug('light', `forget: deleted ${deletedCount} conversation for ${filter.domain} — source: POST /chat/forget by visitor session ${shortToken(filter.sessionToken)}`);
  } else {
    debug('normal', `forget: nothing matched ${filter.domain} / ${shortToken(filter.sessionToken)} — source: POST /chat/forget (already cleared, or a token from another device)`);
  }
  return deletedCount;
}

/**
 * One daily pass over entities with retention enabled. No-op in every UTC hour
 * but SWEEP_HOUR_UTC, so it can sit beside the hourly LeoRefresh ticks.
 * Returns the total deleted. Per-entity failures are logged and skipped — one
 * bad domain must not stop the rest.
 */
async function runRetentionSweepTick(now = Date.now()) {
  if (new Date(now).getUTCHours() !== SWEEP_HOUR_UTC) return 0;

  const entities = await Entity.find({ conversationRetentionDays: { $gt: 0 } })
    .select('domain conversationRetentionDays')
    .lean();

  if (!entities.length) {
    debug('normal', 'sweep: no entity has conversationRetentionDays set — nothing to do');
    return 0;
  }

  let total = 0;
  for (const entity of entities) {
    const days = retentionDays(entity);
    const cutoff = retentionCutoff(entity, now);
    const filter = sweepFilter(entity.domain, cutoff);
    if (!filter) {
      debug('normal', `sweep: skipped ${entity.domain} — source: unusable domain or cutoff (conversationRetentionDays=${entity.conversationRetentionDays})`);
      continue;
    }

    try {
      if (logTier() >= TIERS.verbose) {
        const doomed = await Conversation.find(filter).select('sessionToken lastActiveAt createdAt').lean();
        for (const c of doomed) {
          debug('verbose', `sweep: ${entity.domain} / ${shortToken(c.sessionToken)} last active ${new Date(lastActivityAt(c)).toISOString()} — older than cutoff ${cutoff.toISOString()}`);
        }
      }

      const { deletedCount } = await Conversation.deleteMany(filter);
      total += deletedCount;
      if (deletedCount) {
        debug('light', `sweep: deleted ${deletedCount} conversation(s) for ${entity.domain} — source: entity.conversationRetentionDays=${days}, cutoff ${cutoff.toISOString()} (unanswered handoffs exempt)`);
      } else {
        debug('normal', `sweep: nothing older than ${cutoff.toISOString()} for ${entity.domain} — source: entity.conversationRetentionDays=${days}`);
      }
    } catch (err) {
      console.error(`[Retention] sweep failed for ${entity.domain}:`, err.message);
    }
  }
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
  lastActivityAt,
  SWEEP_HOUR_UTC,
  DAY_MS,
};
