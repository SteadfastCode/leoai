/**
 * Visitor "forget me" + conversation retention (LEO-043).
 *
 * Two destructive paths live here and nowhere else, deliberately:
 *
 *   1. `forgetConversation` — a visitor erasing their OWN transcript. The
 *      filter is built by `forgetFilter`, which returns null rather than a
 *      partial match if either half of the identity is missing. A
 *      `{ domain }`-only filter would erase every visitor on that domain, so
 *      the widening has to be impossible, not merely unlikely.
 *   2. `runRetentionSweepTick` — the daily age-out. Driven per entity by
 *      `conversationRetentionDays` (0 = keep forever, and 0 is the default, so
 *      an entity nobody has configured is never swept).
 *
 * The predicates (`forgetFilter`, `retentionCutoff`, `isExpired`, `sweepDue`)
 * are pure so the scoping and boundary rules are unit-testable without a DB.
 */

const Conversation = require('../models/Conversation');
const Entity = require('../models/Entity');

const DAY_MS = 24 * 60 * 60 * 1000;

// The sweep runs on the existing hourly LeoRefresh tick, at this UTC hour only.
// 4am UTC is deliberately outside LeoRefresh's own 3am window.
const SWEEP_HOUR_UTC = 4;
// Under the nominal 24h so a tick landing early still runs, far enough over an
// hour that a second fire in the same hour cannot double-run.
const SWEEP_MIN_GAP_MS = 20 * 60 * 60 * 1000;

// --- Tiered debug logging ---------------------------------------------------
// RETENTION_DEBUG = off | light | normal | verbose (default: light).
// This is a background cron deleting rows: "it deleted 40 conversations" is
// useless at 4am, so every light-tier line names the SOURCE of the change —
// which setting, on which entity, resolving to which cutoff — not just the
// count. normal adds the per-tick survey, verbose adds per-entity no-ops.
const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function debugTier() {
  const raw = String(process.env.RETENTION_DEBUG || 'light').toLowerCase();
  return TIERS[raw] ?? TIERS.light;
}

function dbg(level, message) {
  if (debugTier() >= TIERS[level]) console.log(`[Retention] ${message}`);
}

// Session tokens are the visitor's only credential — never log one whole.
function maskToken(token) {
  return typeof token === 'string' && token.length > 8
    ? `${token.slice(0, 6)}…${token.slice(-2)}`
    : '(short)';
}

// --- Pure predicates --------------------------------------------------------

/**
 * The one place the "forget me" delete filter is built. Both halves of the
 * caller's own identity are required; anything missing, blank, or not a string
 * yields null and the caller must refuse rather than delete.
 */
function forgetFilter(domain, sessionToken) {
  if (typeof domain !== 'string' || typeof sessionToken !== 'string') return null;
  const d = domain.trim();
  const t = sessionToken.trim();
  if (!d || !t) return null;
  return { domain: d, sessionToken: t };
}

/**
 * Cutoff for an entity's retention setting: a conversation last active
 * strictly BEFORE this is expired. Returns null when retention is disabled —
 * 0, unset, negative, or non-numeric all mean keep forever.
 */
function retentionCutoff(entity, now = Date.now()) {
  const days = Number(entity?.conversationRetentionDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(now - days * DAY_MS);
}

/**
 * Is this conversation past its entity's retention window?
 *
 * Exactly-N-days-old is NOT older than N days and is kept — the comparison is
 * strict. A conversation with an unresolved handoff is never swept: the owner
 * still owes that visitor a reply, and deleting it would drop the reply on the
 * floor with no trace. Every visitor conversation here is anonymous (there are
 * no visitor accounts), so that exclusion is the only narrowing the sweep does.
 */
function isExpired(conversation, entity, now = Date.now()) {
  const cutoff = retentionCutoff(entity, now);
  if (!cutoff) return false;
  if (!conversation || conversation.handoffPending) return false;
  const last = conversation.lastActiveAt || conversation.updatedAt;
  if (!last) return false; // no timestamp — never guess, keep it
  const at = new Date(last).getTime();
  if (!Number.isFinite(at)) return false;
  return at < cutoff.getTime();
}

/** Mongo filter matching exactly what `isExpired` accepts, for one entity. */
function sweepFilter(domain, cutoff) {
  return {
    domain,
    handoffPending: { $ne: true },
    lastActiveAt: { $lt: cutoff },
  };
}

/**
 * Hour gate for the daily sweep, mirroring digestDue/isDueNow. `lastAt` is
 * process-local, so a redeploy inside the sweep hour can let it run a second
 * time — harmless, the sweep is idempotent.
 */
function sweepDue(now = Date.now(), lastAt = 0) {
  if (new Date(now).getUTCHours() !== SWEEP_HOUR_UTC) return false;
  if (!lastAt) return true;
  return now - lastAt >= SWEEP_MIN_GAP_MS;
}

// --- Database paths ---------------------------------------------------------

/**
 * Delete the caller's own conversation. Returns the number deleted (0 or 1),
 * or null when the request did not identify a single conversation — the caller
 * turns that into a 400.
 */
async function forgetConversation({ domain, sessionToken } = {}) {
  const filter = forgetFilter(domain, sessionToken);
  if (!filter) {
    dbg('light', 'forget refused — source: request missing domain or sessionToken, nothing deleted');
    return null;
  }
  const { deletedCount } = await Conversation.deleteOne(filter);
  dbg(
    'light',
    `forget deleted ${deletedCount} — source: visitor request scoped to domain=${filter.domain} ` +
      `sessionToken=${maskToken(filter.sessionToken)} (both required, no wildcard)`
  );
  return deletedCount || 0;
}

let lastSweepAt = 0;

/**
 * Daily age-out. Called from the hourly LeoRefresh tick; no-ops outside the
 * sweep hour. Never throws at the caller — a failing sweep must not take the
 * refresh tick with it.
 */
async function runRetentionSweepTick(now = Date.now()) {
  if (!sweepDue(now, lastSweepAt)) return { ran: false, deleted: 0, entities: 0 };
  lastSweepAt = now;

  const entities = await Entity.find({ conversationRetentionDays: { $gt: 0 } })
    .select('domain conversationRetentionDays')
    .lean();

  dbg('normal', `sweep tick — ${entities.length} entit${entities.length === 1 ? 'y has' : 'ies have'} retention configured`);

  let deleted = 0;
  for (const entity of entities) {
    const cutoff = retentionCutoff(entity, now);
    if (!cutoff) continue;
    try {
      const res = await Conversation.deleteMany(sweepFilter(entity.domain, cutoff));
      deleted += res.deletedCount || 0;
      if (res.deletedCount) {
        dbg(
          'light',
          `sweep deleted ${res.deletedCount} for ${entity.domain} — source: ` +
            `entity.conversationRetentionDays=${entity.conversationRetentionDays} → cutoff ${cutoff.toISOString()} ` +
            `(unresolved handoffs excluded)`
        );
      } else {
        dbg('verbose', `sweep deleted 0 for ${entity.domain} — cutoff ${cutoff.toISOString()}`);
      }
    } catch (err) {
      console.error(`[Retention] sweep failed for ${entity.domain}:`, err.message);
    }
  }

  dbg('normal', `sweep tick complete — ${deleted} conversation(s) deleted across ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}`);
  return { ran: true, deleted, entities: entities.length };
}

module.exports = {
  forgetFilter,
  retentionCutoff,
  isExpired,
  sweepFilter,
  sweepDue,
  forgetConversation,
  runRetentionSweepTick,
  SWEEP_HOUR_UTC,
};
