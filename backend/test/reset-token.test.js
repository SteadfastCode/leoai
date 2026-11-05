// Password-reset tokens are stored hashed, not in plaintext (LEO-098).
//
// `POST /auth/forgot-password` used to write the raw 32-byte token onto the
// user document, and `POST /auth/reset-password` looked that raw value up. The
// token is the whole credential — no password, no inbox access needed — so read
// access to the `users` collection (a backup, a leaked connection string, a
// superadmin browsing data) was account takeover for anyone with a live reset
// request. Now only the SHA-256 digest is stored, exactly as ApiKey already
// does, and the lookup hashes the token it was handed.
//
// Two halves: the pure hash function, then the real auth router over in-memory
// MongoDB with the mailer stubbed so the emailed token can be captured and
// compared against what landed in the database.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

function stubModule(resolvedPath, exportsObject) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsObject,
  };
}

const srcDir = path.join(__dirname, '..', 'src');

// Captures every (to, subject, body) the router hands the mailer. Requiring the
// real notifications service would drag in the twilio/resend clients — and this
// must never send a real email.
const sentEmails = [];
stubModule(require.resolve(path.join(srcDir, 'services', 'notifications.js')), {
  sendEmailRaw: async (to, subject, body) => { sentEmails.push({ to, subject, body }); },
});

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

const authRouter = require('../src/routes/auth');
const User = require('../src/models/User');
const { hashResetToken } = require('../src/services/resetToken');

// sha256('leoai-reset-token'), computed independently of the implementation.
const KNOWN_INPUT = 'leoai-reset-token';
const KNOWN_DIGEST = 'bdb4b47b70e494bc1267a9cb94ec99de6a5def78fb125d6dd0c028cc064b370c';

test('hashResetToken is a stable, total SHA-256 hex digest', async (t) => {
  await t.test('a known input yields the known 64-char hex digest', () => {
    const digest = hashResetToken(KNOWN_INPUT);
    assert.equal(digest, KNOWN_DIGEST);
    assert.equal(digest.length, 64);
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  await t.test('the same input twice is stable', () => {
    assert.equal(hashResetToken(KNOWN_INPUT), hashResetToken(KNOWN_INPUT));
  });

  await t.test('a one-character change differs', () => {
    assert.notEqual(hashResetToken('leoai-reset-tokeo'), KNOWN_DIGEST);
    assert.notEqual(hashResetToken(KNOWN_INPUT + 'x'), KNOWN_DIGEST);
  });

  await t.test('a non-string returns null rather than throwing', () => {
    // The lookup must never run with one of these: `passwordResetToken: null`
    // would match every user who has no live reset request at all.
    for (const bad of [null, undefined, '', 42, true, {}, [], { $gt: '' }, ['a'], () => {}]) {
      assert.equal(hashResetToken(bad), null, `expected null for ${JSON.stringify(bad) ?? String(bad)}`);
    }
  });
});

test('the reset flow stores a digest and still accepts the emailed token', async (t) => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const post = (route, body) => fetch(`${baseUrl}/auth/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const EMAIL = 'reset@example.com';
  const OLD_PASSWORD = 'oldpassword1';
  const NEW_PASSWORD = 'newpassword1';

  const registered = await post('register', {
    name: 'Reset Test',
    email: EMAIL,
    password: OLD_PASSWORD,
    entityDomain: 'reset.example.com',
  });
  assert.equal(registered.status, 201);

  let emailedToken;
  let storedToken;

  await t.test('forgot-password stores something other than the emailed token', async () => {
    sentEmails.length = 0;
    const r = await post('forgot-password', { email: EMAIL });
    assert.equal(r.status, 200);

    assert.equal(sentEmails.length, 1, 'exactly one reset email');
    const match = /[?&]token=([0-9a-f]+)/.exec(sentEmails[0].body);
    assert.ok(match, `reset link should carry a hex token: ${sentEmails[0].body}`);
    emailedToken = match[1];
    assert.equal(emailedToken.length, 64); // crypto.randomBytes(32) as hex

    const user = await User.findOne({ email: EMAIL }).lean();
    storedToken = user.passwordResetToken;
    assert.ok(storedToken, 'a reset token must be stored');
    // The whole point of the item: plaintext in the database is takeover.
    assert.notEqual(storedToken, emailedToken, 'stored token must not be the emailed token');
    assert.equal(storedToken, hashResetToken(emailedToken), 'stored token must be the digest of the emailed one');
    assert.ok(user.passwordResetExpiresAt > new Date(), 'request is still live');
    assert.equal(user.refreshTokens.length, 1, 'register left one refresh token to clear later');
  });

  await t.test('the stored value is not usable as a reset token', async () => {
    const r = await post('reset-password', { token: storedToken, password: NEW_PASSWORD });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /invalid or has expired/i);

    // Still the old password, and the request is still live for the real token.
    const login = await post('login', { email: EMAIL, password: OLD_PASSWORD });
    assert.equal(login.status, 200);
    const user = await User.findOne({ email: EMAIL }).lean();
    assert.equal(user.passwordResetToken, storedToken);
  });

  await t.test('the emailed token still resets the password and clears refresh tokens', async () => {
    const r = await post('reset-password', { token: emailedToken, password: NEW_PASSWORD });
    assert.equal(r.status, 200);

    const user = await User.findOne({ email: EMAIL }).lean();
    assert.equal(user.passwordResetToken, undefined, 'token consumed');
    assert.equal(user.passwordResetExpiresAt, undefined, 'expiry cleared');
    assert.deepEqual(user.refreshTokens, [], 'every refresh token invalidated');

    assert.equal((await post('login', { email: EMAIL, password: NEW_PASSWORD })).status, 200);
    assert.equal((await post('login', { email: EMAIL, password: OLD_PASSWORD })).status, 401);
  });

  await t.test('a consumed token cannot be replayed', async () => {
    const r = await post('reset-password', { token: emailedToken, password: 'thirdpassword1' });
    assert.equal(r.status, 400);
  });

  await mongoose.disconnect();
  await mongod.stop();
  server.close();
});
