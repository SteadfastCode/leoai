/**
 * Signup rules for POST /auth/onboard, kept free of Mongoose so every one of
 * them can be unit-tested without a database (LEO-108).
 *
 * The route used to take `domain` straight off the request body and write
 * `memberships: [{ entityDomain: domain, roles: ['owner'] }]` plus an
 * `Entity.findOneAndUpdate({ domain }, { $set: { ownerEmail, ... } },
 * { upsert: true })`. Nothing checked whether that domain already belonged to
 * anyone, so a second holder of a valid alpha code could sign up naming a live
 * entity's domain and receive `owner` on it — its conversations, its settings,
 * its billing page — while the `$set` rewrote `ownerEmail`, the address every
 * handoff SMS/email and quota warning is sent to. A second person joining an
 * existing entity has a door already: the invite flow.
 *
 * The domain is also the identity here — `entityDomain` strings are compared
 * verbatim all over this backend — so `Example.com`, `www.example.com` and
 * `https://example.com/` must not be three different entities, or the claim
 * check above is trivially sidestepped by typing the same site differently.
 */

// Debug tiers — ONBOARD_LOG_LEVEL = off | light | normal | verbose:
//   light (default) one line per REFUSAL and per code RELEASE, naming the
//                   reason that produced it and the domain that asked. A
//                   refusal is a 403/409 body only the asker sees, and a
//                   release silently moves a code's useCount back down, so
//                   these logs are the only server-side record of either
//   normal          adds every accepted signup (raw domain -> normalised) and
//                   every code consumption with the useCount it landed on
//   verbose         adds the rejected normalisations, i.e. the 400s
const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.ONBOARD_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[Onboard] ${message}`);
}

// One label of a hostname: alphanumeric ends, hyphens allowed inside.
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
// A plausible public hostname: at least two labels and an alphabetic TLD. A
// dotless name (`localhost`, an intranet name) is not a site Leo can crawl and
// is not accepted as an entity identity.
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*\\.[a-z]{2,}$`);

/**
 * The entity-identity form of whatever the signup form sent: lowercased,
 * scheme/path/query/port/`www.` stripped. Returns null — never throws — for
 * anything that is not a plausible hostname, which callers must answer with a
 * 400 rather than storing.
 */
function normalizeDomain(raw) {
  if (typeof raw !== 'string') return null;

  let host = raw.trim().toLowerCase();
  if (!host) return null;

  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  host = host.split(/[/?#]/)[0];                      // path, query, fragment
  host = host.split(':')[0];                          // port
  if (host.startsWith('www.')) host = host.slice(4);
  host = host.replace(/\.+$/, '');                    // trailing root dot

  if (!HOSTNAME_RE.test(host)) {
    debug('verbose', `rejected domain ${JSON.stringify(raw)} -> ${JSON.stringify(host)} (not a hostname)`);
    return null;
  }
  return host;
}

// Deliberately one message for both reasons: which of the two is true tells an
// unauthenticated caller something about an entity it has no business knowing.
// The reason is on the log line instead.
const CLAIMED =
  'That domain is already set up on LeoAI. Ask its owner to invite you from Settings → Team.';

/**
 * May this signup claim this domain? Takes the two facts rather than looking
 * them up, so the rule stays pure: `entityExists` — an Entity document for the
 * domain; `memberExists` — any User holding a membership for it (an entity
 * whose document was deleted but whose team is still around).
 */
function claimCheck({ entityExists, memberExists } = {}) {
  if (entityExists) return { ok: false, status: 409, error: CLAIMED, reason: 'entity-exists' };
  if (memberExists) return { ok: false, status: 409, error: CLAIMED, reason: 'member-exists' };
  return { ok: true };
}

/**
 * Why the atomic consume found no slot. The consume is a single conditional
 * update so the cap cannot be read and written in two steps, which means a
 * no-match cannot say which condition failed — this re-reads the document
 * purely to keep the three messages the signup form used to get. `codeDoc` is
 * null when there is no such alpha code at all.
 */
function describeCodeRefusal(codeDoc, now = new Date()) {
  if (!codeDoc || codeDoc.active !== true) {
    return { status: 403, error: 'Invalid or inactive alpha code', reason: codeDoc ? 'inactive' : 'unknown' };
  }
  if (codeDoc.expiresAt && new Date(codeDoc.expiresAt) < now) {
    return { status: 403, error: 'This alpha code has expired', reason: 'expired' };
  }
  if (codeDoc.maxUses !== null && codeDoc.maxUses !== undefined && codeDoc.useCount >= codeDoc.maxUses) {
    return { status: 403, error: 'This alpha code has already been used', reason: 'exhausted' };
  }
  // The document satisfies every condition now, so the slot was taken between
  // the failed update and this read — a concurrent signup won it.
  return { status: 403, error: 'This alpha code has already been used', reason: 'raced' };
}

/**
 * Filter for the one-shot consume: the code, its type, the active flag, and
 * both nullable limits. `maxUses: null` also matches a missing field, which is
 * the unlimited case; the cap itself needs `$expr` because it compares two
 * fields of the same document. No match means no slot — there is no window
 * between checking the cap and spending it.
 */
function codeConsumeFilter(code, now = new Date()) {
  return {
    code,
    type: 'alpha',
    active: true,
    $and: [
      { $or: [{ maxUses: null }, { $expr: { $lt: ['$useCount', '$maxUses'] } }] },
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
    ],
  };
}

module.exports = {
  normalizeDomain,
  claimCheck,
  describeCodeRefusal,
  codeConsumeFilter,
  debug,
  CLAIMED,
};
