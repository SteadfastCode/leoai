const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const User = require('../models/User');
const { requireAuth, signAccessToken, signRefreshToken, JWT_SECRET } = require('../middleware/auth');

const RP_NAME = 'LeoAI Dashboard';
const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.DASHBOARD_ORIGIN || 'http://localhost:5173';

// ---------------------------------------------------------------------------
// Password auth
// ---------------------------------------------------------------------------

// POST /auth/register — create a new user account
// entityDomain is required unless role is 'superadmin'
router.post('/register', async (req, res) => {
  const { name, email, password, entityDomain, role } = req.body;
  const assignedRole = role || 'owner';
  const needsDomain = assignedRole !== 'superadmin';
  if (!name || !email || !password || (needsDomain && !entityDomain)) {
    return res.status(400).json({ error: 'name, email, password, and entityDomain are required' });
  }

  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password, 12);
    const memberships = entityDomain
      ? [{ entityDomain, roles: [assignedRole], permissions: [] }]
      : [];

    const user = await User.create({
      name,
      email,
      hashedPassword,
      memberships,
    });

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    user.refreshTokens.push({ token: refreshToken, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
    await user.save();

    res.status(201).json({ accessToken, refreshToken, user: safeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  try {
    const user = await User.findOne({ email });
    if (!user || !user.hashedPassword) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.hashedPassword);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);

    // Prune expired refresh tokens and add new one
    user.refreshTokens = user.refreshTokens.filter((t) => t.expiresAt > new Date());
    user.refreshTokens.push({ token: refreshToken, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
    await user.save();

    res.json({ accessToken, refreshToken, user: safeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/refresh — exchange refresh token for new access token
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });

  try {
    const payload = jwt.verify(refreshToken, JWT_SECRET);
    if (payload.type !== 'refresh') return res.status(401).json({ error: 'Invalid token type' });

    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const stored = user.refreshTokens.find((t) => t.token === refreshToken && t.expiresAt > new Date());
    if (!stored) return res.status(401).json({ error: 'Refresh token invalid or expired' });

    const accessToken = signAccessToken(user);
    res.json({ accessToken });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// POST /auth/logout — revoke refresh token
router.post('/logout', requireAuth(), async (req, res) => {
  const { refreshToken } = req.body;
  try {
    const user = await User.findById(req.user._id);
    user.refreshTokens = user.refreshTokens.filter((t) => t.token !== refreshToken);
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/me
router.get('/me', requireAuth(), (req, res) => {
  res.json(safeUser(req.user));
});

// ---------------------------------------------------------------------------
// Passkey auth (WebAuthn / SimpleWebAuthn)
// ---------------------------------------------------------------------------

// GET /auth/passkey/register-options — start passkey registration ceremony
router.get('/passkey/register-options', requireAuth(), async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: Buffer.from(user._id.toString()),
      userName: user.email,
      userDisplayName: user.name,
      attestationType: 'none',
      excludeCredentials: user.passkeys.map((p) => ({
        id: p.credentialID,
        transports: p.transports,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    user.currentChallenge = options.challenge;
    await user.save();
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/passkey/register-verify — complete passkey registration
router.post('/passkey/register-verify', requireAuth(), async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const { body, passkeyName } = req.body;

    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    if (!verification.verified) return res.status(400).json({ error: 'Passkey verification failed' });

    const { registrationInfo } = verification;
    user.passkeys.push({
      credentialID: registrationInfo.credentialID,
      credentialPublicKey: Buffer.from(registrationInfo.credentialPublicKey),
      counter: registrationInfo.counter,
      deviceType: registrationInfo.credentialDeviceType,
      backedUp: registrationInfo.credentialBackedUp,
      transports: body.response.transports || [],
      name: passkeyName || 'Passkey',
    });
    user.currentChallenge = null;
    await user.save();

    res.json({ ok: true, passkeys: user.passkeys.map((p) => ({ credentialID: p.credentialID, name: p.name })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/passkey/login-options?email= — start passkey authentication ceremony
router.get('/passkey/login-options', async (req, res) => {
  try {
    const { email } = req.query;
    const user = email ? await User.findOne({ email }) : null;

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'preferred',
      allowCredentials: user?.passkeys.map((p) => ({
        id: p.credentialID,
        transports: p.transports,
      })) || [],
    });

    // Store challenge on user if we know who they are, otherwise use session
    // For simplicity: require email for passkey login
    if (user) {
      user.currentChallenge = options.challenge;
      await user.save();
    }

    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/passkey/login-verify
router.post('/passkey/login-verify', async (req, res) => {
  try {
    const { email, body } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'User not found' });

    const passkey = user.passkeys.find((p) => p.credentialID === body.id);
    if (!passkey) return res.status(401).json({ error: 'Passkey not found' });

    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      authenticator: {
        credentialID: passkey.credentialID,
        credentialPublicKey: passkey.credentialPublicKey,
        counter: passkey.counter,
        transports: passkey.transports,
      },
    });

    if (!verification.verified) return res.status(401).json({ error: 'Passkey verification failed' });

    passkey.counter = verification.authenticationInfo.newCounter;
    user.currentChallenge = null;

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    user.refreshTokens = user.refreshTokens.filter((t) => t.expiresAt > new Date());
    user.refreshTokens.push({ token: refreshToken, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
    await user.save();

    res.json({ accessToken, refreshToken, user: safeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function safeUser(user) {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    memberships: user.memberships || [],
    showNameInReplies: user.showNameInReplies,
    hasPassword: !!user.hashedPassword,
    passkeys: (user.passkeys || []).map((p) => ({ credentialID: p.credentialID, name: p.name })),
  };
}

module.exports = router;
