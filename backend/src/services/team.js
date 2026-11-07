/**
 * Pure helpers for team membership logic, kept free of Mongoose so they can be
 * unit-tested without a database.
 */

const { ROLE_PRESETS } = require('../models/Permission');

// The role an invite gets when the caller names none — unchanged from the
// `role || 'agent'` that used to sit inline in the invite route.
const DEFAULT_ROLE = 'agent';

// Debug tiers — TEAM_ROLE_LOG_LEVEL = off | light | normal | verbose:
//   light (default) one line per REFUSAL, naming the SOURCE that asked for the
//                   role and the role it asked for — the refusal is a 400/403
//                   body the asker sees and nobody else does, so the log is the
//                   only place the attempt is recorded server-side
//   normal          adds every accepted role, with its source
//   verbose         adds the no-role-given case, i.e. the 'agent' default
const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.TEAM_ROLE_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[TeamRole] ${message}`);
}

/**
 * The ONE rule for "may this role string be handed to a member?" — called by
 * every door that writes a role, so they cannot drift apart again (LEO-106).
 *
 * There were two such doors and only one had locks: `PATCH team/:userId`
 * rejected an unknown role AND rejected `superadmin` by name, while
 * `POST invites` took `role` straight off the request body. Since
 * `isSuperAdmin()` is true when ANY membership for ANY domain holds the string
 * `superadmin`, and the `owner` preset carries USERS_MANAGE, an entity owner
 * could invite themselves as `superadmin` on their own domain and accept it —
 * global admin in two requests.
 *
 * `superadmin` needs refusing BY NAME and not merely by the preset check,
 * because it is itself a ROLE_PRESETS key.
 *
 * `source` is for the log line only; it never affects the verdict.
 *
 * Returns { ok: true, role } where `role` is what the caller should store (the
 * default when none was given), or { ok: false, error } with a message fit to
 * hand straight back to the caller.
 */
function assertAssignableRole(role, source = 'unknown') {
  if (role === undefined || role === null || role === '') {
    debug('verbose', `${source}: no role given, defaulting to '${DEFAULT_ROLE}'`);
    return { ok: true, role: DEFAULT_ROLE };
  }

  if (typeof role !== 'string' || !Object.prototype.hasOwnProperty.call(ROLE_PRESETS, role)) {
    debug('light', `${source}: refused unknown role ${JSON.stringify(role)}`);
    return { ok: false, error: 'Unknown role' };
  }

  if (role === 'superadmin') {
    debug('light', `${source}: refused 'superadmin' — it is never assignable through the team routes`);
    return { ok: false, error: 'superadmin cannot be assigned' };
  }

  debug('normal', `${source}: accepted role '${role}'`);
  return { ok: true, role };
}

/**
 * True when the given user is an owner of `domain` and no OTHER member also
 * holds the owner role there — i.e. demoting or removing them would leave the
 * entity ownerless.
 *
 * `members` is an array of user-shaped objects: { _id, memberships: [{ entityDomain, roles }] }.
 * Returns false when the user is not a member or not an owner of the domain.
 */
function isLastOwner(members, userId, domain) {
  const id = String(userId);
  const ownsDomain = (m) =>
    (m.memberships || []).some(
      (ms) => ms.entityDomain === domain && (ms.roles || []).includes('owner')
    );

  const target = members.find((m) => String(m._id) === id);
  if (!target || !ownsDomain(target)) return false;

  return !members.some((m) => String(m._id) !== id && ownsDomain(m));
}

module.exports = { isLastOwner, assertAssignableRole, DEFAULT_ROLE };
