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

const crypto = require('crypto');
const User = require('../models/User');
const Code = require('../models/Code');
const Invite = require('../models/Invite');
const { requireAuth, signAccessToken, signRefreshToken, JWT_SECRET } = require('../middleware/auth');
const { sendEmailRaw } = require('../services/notifications');

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

// POST /auth/onboard — alpha signup: validate code, create user + entity membership, return tokens
router.post('/onboard', async (req, res) => {
  const { name, email, password, alphaCode, domain } = req.body;
  if (!name || !email || !password || !alphaCode || !domain) {
    return res.status(400).json({ error: 'name, email, password, alphaCode, and domain are required' });
  }

  try {
    // Validate alpha code against DB
    const code = await Code.findOne({ code: alphaCode.trim(), type: 'alpha', active: true });
    if (!code) return res.status(403).json({ error: 'Invalid or inactive alpha code' });
    if (code.maxUses !== null && code.useCount >= code.maxUses) return res.status(403).json({ error: 'This alpha code has already been used' });
    if (code.expiresAt && code.expiresAt < new Date()) return res.status(403).json({ error: 'This alpha code has expired' });

    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await User.create({
      name,
      email,
      hashedPassword,
      memberships: [{ entityDomain: domain, roles: ['owner'], permissions: [] }],
    });

    const accessToken  = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    user.refreshTokens.push({ token: refreshToken, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
    await user.save();

    // Record code usage
    code.useCount += 1;
    code.usedBy.push({ email: email.trim(), usedAt: new Date() });
    await code.save();

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
    const { credential, credentialDeviceType, credentialBackedUp } = registrationInfo;
    user.passkeys.push({
      credentialID: credential.id,
      credentialPublicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
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

// GET /auth/passkey/login-options — discoverable credential flow (no email needed)
router.get('/passkey/login-options', async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'preferred',
      allowCredentials: [], // let the OS/browser present available passkeys
    });

    // Store challenge in a short-lived signed token so we can verify it
    // without a server-side session. Embed it in the response.
    const challengeToken = jwt.sign({ challenge: options.challenge }, JWT_SECRET, { expiresIn: '5m' });
    res.json({ ...options, challengeToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/passkey/login-verify
router.post('/passkey/login-verify', async (req, res) => {
  try {
    const { body, challengeToken } = req.body;

    // Recover challenge from signed token (stateless — no session or per-user storage needed)
    let expectedChallenge;
    try {
      const payload = jwt.verify(challengeToken, JWT_SECRET);
      expectedChallenge = payload.challenge;
    } catch {
      return res.status(400).json({ error: 'Challenge expired or invalid — try again' });
    }

    // Identify user from userHandle (set to user._id during registration)
    if (!body.response?.userHandle) return res.status(401).json({ error: 'No user handle in response' });
    const userId = Buffer.from(body.response.userHandle, 'base64url').toString('utf8');
    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const passkey = user.passkeys.find((p) => p.credentialID === body.id);
    if (!passkey) return res.status(401).json({ error: 'Passkey not found' });

    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: passkey.credentialID,
        publicKey: Buffer.from(passkey.credentialPublicKey),
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

// DELETE /auth/passkey/:credentialId — remove a registered passkey
router.delete('/passkey/:credentialId', requireAuth(), async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const before = user.passkeys.length;
    user.passkeys = user.passkeys.filter((p) => p.credentialID !== req.params.credentialId);
    if (user.passkeys.length === before) return res.status(404).json({ error: 'Passkey not found' });
    await user.save();
    res.json({ ok: true, passkeys: user.passkeys.map((p) => ({ credentialID: p.credentialID, name: p.name })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

// POST /auth/forgot-password — send reset link if email exists
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const user = await User.findOne({ email });
    // Always respond 200 to avoid leaking whether email is registered
    if (!user || !user.hashedPassword) return res.json({ ok: true });

    const token = crypto.randomBytes(32).toString('hex');
    user.passwordResetToken = token;
    user.passwordResetExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    const dashboardOrigin = process.env.DASHBOARD_ORIGIN || 'http://localhost:5173';
    const resetUrl = `${dashboardOrigin}/#/reset-password?token=${token}`;

    await sendEmailRaw(
      user.email,
      'Reset your LeoAI password',
      `Hi ${user.name},\n\nClick the link below to reset your password. This link expires in 1 hour.\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/reset-password — set new password using token
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'token and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const user = await User.findOne({
      passwordResetToken: token,
      passwordResetExpiresAt: { $gt: new Date() },
    });
    if (!user) return res.status(400).json({ error: 'Reset link is invalid or has expired' });

    user.hashedPassword = await bcrypt.hash(password, 12);
    user.passwordResetToken = undefined;
    user.passwordResetExpiresAt = undefined;
    // Invalidate all existing refresh tokens on password reset
    user.refreshTokens = [];
    await user.save();

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Invite acceptance (public)
// ---------------------------------------------------------------------------

// GET /auth/invite/:token — validate token, return invite details
router.get('/invite/:token', async (req, res) => {
  try {
    const invite = await Invite.findOne({
      token: req.params.token,
      acceptedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (!invite) return res.status(404).json({ error: 'Invite not found or expired' });

    const Entity = require('../models/Entity');
    const entity = await Entity.findOne({ domain: invite.domain });
    const existingUser = await User.findOne({ email: invite.email });

    res.json({
      email: invite.email,
      role: invite.role,
      domain: invite.domain,
      entityName: entity?.name || invite.domain,
      needsAccount: !existingUser,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/invite/:token/accept — accept invite
// New users: provide name + password. Existing users: membership is added automatically.
router.post('/invite/:token/accept', async (req, res) => {
  try {
    const invite = await Invite.findOne({
      token: req.params.token,
      acceptedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (!invite) return res.status(404).json({ error: 'Invite not found or expired' });

    let user = await User.findOne({ email: invite.email });

    if (user) {
      // Existing user — just add membership if not already present
      const alreadyMember = user.memberships.some((m) => m.entityDomain === invite.domain);
      if (!alreadyMember) {
        user.memberships.push({ entityDomain: invite.domain, roles: [invite.role], permissions: [] });
        await user.save();
      }
    } else {
      // New user — name and password required
      const { name, password } = req.body;
      if (!name || !password) return res.status(400).json({ error: 'name and password are required' });
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

      user = await User.create({
        name,
        email: invite.email,
        hashedPassword: await bcrypt.hash(password, 12),
        memberships: [{ entityDomain: invite.domain, roles: [invite.role], permissions: [] }],
      });
    }

    invite.acceptedAt = new Date();
    await invite.save();

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
