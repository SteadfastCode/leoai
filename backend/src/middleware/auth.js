const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ApiKey = require('../models/ApiKey');
const { ROLE_PRESETS } = require('../models/Permission');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

/**
 * Returns true if the user has the superadmin role in any membership.
 */
function isSuperAdmin(user) {
  return user?.memberships?.some((m) => m.roles?.includes('superadmin')) ?? false;
}

// Synthetic principal for X-API-Key requests. Shaped so isSuperAdmin() returns true and
// every existing superadmin branch works unchanged. It deliberately has no _id: an API
// key is not a user, and anything attributing an action to a person should read
// req.apiKey.label instead of pretending this was someone.
const API_KEY_PRINCIPAL = Object.freeze({
  _id: null,
  isApiKey: true,
  email: null,
  name: 'api-key',
  memberships: [Object.freeze({ entityDomain: '*', roles: Object.freeze(['superadmin']), permissions: Object.freeze([]) })],
});

/**
 * Resolves an X-API-Key header.
 *   null   → no header present, caller should fall through to Bearer auth
 *   false  → header present but invalid, caller MUST reject
 *   object → the ApiKey document
 *
 * Note the DB error path returns false, not null. A lookup failure must never downgrade
 * into "no key was supplied" and let the request continue unauthenticated.
 */
async function resolveApiKey(req) {
  const rawKey = req.headers['x-api-key'];
  if (!rawKey) return null;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const key = await ApiKey.findOne({ keyHash }).catch(() => null);
  if (!key) return false;
  ApiKey.updateOne({ _id: key._id }, { lastUsedAt: new Date() }).catch(() => {});
  return key;
}

/**
 * Verifies the Bearer token and attaches req.user.
 *
 * @param {string|null} permission — optional PERMISSIONS constant (e.g. 'settings.edit').
 *   If provided, the user must have this permission for req.params.domain.
 *   Superadmin always passes. Pass null to require auth only.
 */
function requireAuth(permission = null) {
  return async (req, res, next) => {
    // X-API-Key acts as a superadmin principal. Checked before Bearer so the MCP server
    // can reach dashboard and scrape routes, which previously only accepted a JWT —
    // 5 of its 8 tools 401'd. Fails closed: a present-but-invalid key is rejected here
    // and never falls through to the Bearer path.
    const apiKey = await resolveApiKey(req);
    if (apiKey === false) return res.status(401).json({ error: 'Invalid API key' });
    if (apiKey) {
      req.apiKey = apiKey;
      req.user = API_KEY_PRINCIPAL;
      return next();
    }

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = header.slice(7);
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const user = await User.findById(payload.sub).select(
      '-hashedPassword -refreshTokens -currentChallenge'
    );
    if (!user) return res.status(401).json({ error: 'User not found' });

    req.user = user;

    // Permission gate — superadmin bypasses all checks
    if (permission && !isSuperAdmin(user)) {
      const domain = req.params.domain;
      if (!domain) return res.status(403).json({ error: 'Forbidden' });
      if (!user.hasPermission(domain, permission, ROLE_PRESETS)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    next();
  };
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user._id },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

function signRefreshToken(user) {
  return jwt.sign(
    { sub: user._id, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

module.exports = { requireAuth, signAccessToken, signRefreshToken, JWT_SECRET, isSuperAdmin, resolveApiKey };
