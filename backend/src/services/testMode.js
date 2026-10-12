const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { resolveApiKey, isSuperAdmin, JWT_SECRET } = require('../middleware/auth');

/**
 * Test-mode gate for POST /chat (LEO-025, extended for the owner playground in LEO-040).
 *
 * A chat request is test-mode when and only when it carries ONE of:
 *   1. a valid X-API-Key header, validated against the ApiKey model (MCP, smoke tests); or
 *   2. a valid dashboard access token (Bearer JWT) belonging to a user with a membership
 *      for the SAME domain the request names — the in-dashboard playground.
 *
 * Nothing in the request body can grant test mode — the body is visitor-controlled, and a
 * body flag would let any visitor suppress quota counting and owner notifications. The
 * domain in the body is only ever used as the thing the credential is checked AGAINST:
 * naming someone else's domain fails the membership check, so the playground can never be
 * pointed at another entity. A superadmin passes for any domain, matching requireAuth.
 *
 * resolveApiKey's contract (middleware/auth.js): null = no header, false = header present
 * but invalid (including DB lookup failure), object = the ApiKey document. Only the object
 * case is test mode; an invalid key is treated as a normal visitor message rather than
 * rejected, so a stale MCP key degrades to a real conversation instead of an error — and it
 * does NOT fall through to the JWT path, because a request carrying a key it could not prove
 * has already failed its own authentication.
 *
 * Every failure direction is the same one: not test mode, i.e. a real visitor message. The
 * gate therefore swallows its own errors — a DB blip must never turn a chat into a 500.
 *
 * Debug tiers — TEST_MODE_LOG_LEVEL = off | light | normal | verbose:
 *   light (default) one line per GRANT, naming which credential granted it
 *   normal          adds denials that had a credential (bad key, wrong domain)
 *   verbose         adds the anonymous case (no credential at all) — i.e. all visitor traffic
 * The decision is invisible in the reply body apart from `isTest`, and the thing it suppresses
 * (quota, notifications) is only noticeable later, so the light tier always says the SOURCE.
 */

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.TEST_MODE_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[TestMode] ${message}`);
}

/**
 * Resolves a dashboard access token to its user, or null.
 *   no/!Bearer header → null       (not a dashboard caller)
 *   bad signature, expired, refresh token, unknown user, DB error → null
 *
 * Refresh tokens are signed with the same secret and would otherwise verify, so the
 * `type: 'refresh'` claim is rejected explicitly: a refresh token lives 7 days in
 * localStorage and is not proof of an active session.
 */
async function resolveDashboardSession(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  let payload;
  try {
    payload = jwt.verify(header.slice(7), JWT_SECRET);
  } catch {
    return null;
  }
  if (!payload?.sub || payload.type === 'refresh') return null;
  const user = await User.findById(payload.sub).select('memberships').lean().catch(() => null);
  return user || null;
}

/** True when this user may put THIS domain into test mode. */
function sessionOwnsDomain(user, domain) {
  if (!user || typeof domain !== 'string' || !domain) return false;
  if (isSuperAdmin(user)) return true;
  return !!user.memberships?.some((m) => m.entityDomain === domain);
}

function createTestModeGate({ resolveKey = resolveApiKey, resolveSession = resolveDashboardSession } = {}) {
  return async function isTestModeRequest(req) {
    try {
      const key = await resolveKey(req);
      if (typeof key === 'object' && key !== null) {
        debug('light', `test mode GRANTED — source: X-API-Key "${key.label || 'unlabelled'}"`);
        return true;
      }
      if (key === false) {
        debug('normal', 'test mode DENIED — source: X-API-Key present but did not resolve');
        return false;
      }

      const domain = req.body?.domain;
      const user = await resolveSession(req);
      if (!user) {
        debug('verbose', 'test mode DENIED — source: no X-API-Key and no valid dashboard session');
        return false;
      }
      if (!sessionOwnsDomain(user, domain)) {
        debug('normal', `test mode DENIED — source: dashboard session ${user._id} has no membership for "${domain}"`);
        return false;
      }
      debug('light', `test mode GRANTED — source: dashboard session ${user._id} for its own domain "${domain}"`);
      return true;
    } catch (err) {
      // Never fail open, never 500 the chat: an unexpected error means normal visitor mode.
      debug('normal', `test mode DENIED — source: gate error (${err.message})`);
      return false;
    }
  };
}

module.exports = {
  createTestModeGate,
  isTestModeRequest: createTestModeGate(),
  resolveDashboardSession,
  sessionOwnsDomain,
};
