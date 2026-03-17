const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { ROLE_PRESETS } = require('../models/Permission');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

/**
 * Returns true if the user has the superadmin role in any membership.
 */
function isSuperAdmin(user) {
  return user.memberships?.some((m) => m.roles?.includes('superadmin')) ?? false;
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
      '-hashedPassword -refreshTokens -passkeys -currentChallenge'
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

module.exports = { requireAuth, signAccessToken, signRefreshToken, JWT_SECRET, isSuperAdmin };
