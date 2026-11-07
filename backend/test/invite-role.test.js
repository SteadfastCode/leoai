// Role assignment through the team routes (LEO-106).
//
// There are three doors that turn a role string into a membership, and before
// this item only one of them had a lock:
//
//   POST /api/dashboard/entities/:domain/invites   took `role` off the request
//                                                 body and stored it verbatim
//   POST /auth/invite/:token/accept                wrote invite.role straight
//                                                 into user.memberships
//   PATCH /api/dashboard/entities/:domain/team/:id  rejected unknown roles AND
//                                                 rejected `superadmin` by name
//
// `isSuperAdmin()` is true when ANY membership for ANY domain holds the string
// `superadmin`, and the `owner` preset carries USERS_MANAGE — so an entity
// owner could invite themselves as `superadmin` on their own domain and accept
// it. Two requests from a customer account to the admin console, every other
// entity's conversations and billing, entity hard-delete, API-key minting and
// impersonation.
//
// The rule now lives in services/team.js and is called from all three, so the
// locks cannot drift apart again. Three things are asserted below and all three
// are red against unmodified main: the pure contract of
// `assertAssignableRole`, the invite route's 400 with no row written, and the
// 403 at acceptance for an invite that was minted (or hand-seeded) before the
// first guard existed.
//
// The REAL middleware/auth is used — real User documents, real signed tokens,
// real permission gate — because the escalation path being closed runs through
// an account that legitimately holds USERS_MANAGE. Only the outbound email and
// the embedding/RAG services are stubbed via require.cache, so no Resend,
// Voyage or Claude call can fire.
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

// Records instead of sending. A real send is impossible; the recorded body also
// lets the 201 case prove which role the invitee was actually told they'd get.
const sentEmails = [];
stubModule(require.resolve(path.join(srcDir, 'services', 'email.js')), {
  sendEmailRaw: async (to, subject, text) => { sentEmails.push({ to, subject, text }); },
});

stubModule(require.resolve(path.join(srcDir, 'services', 'embeddings.js')), {
  embedTexts: async () => { throw new Error('embedTexts must not be called in this suite'); },
  embedQuery: async () => { throw new Error('embedQuery must not be called in this suite'); },
});

stubModule(require.resolve(path.join(srcDir, 'services', 'rag.js')), {
  retrieveContext: async () => { throw new Error('retrieveContext must not be called in this suite'); },
});

const { ROLE_PRESETS } = require('../src/models/Permission');
const { assertAssignableRole } = require('../src/services/team');

// ---------------------------------------------------------------------------
// The contract — pure, no DB, no server.
// ---------------------------------------------------------------------------

test('every ROLE_PRESETS key except superadmin is assignable', () => {
  const keys = Object.keys(ROLE_PRESETS);
  assert.ok(keys.includes('superadmin'), 'superadmin must be a preset, else this test proves nothing');
  assert.ok(keys.length > 1, 'there must be presets other than superadmin');

  for (const role of keys.filter((k) => k !== 'superadmin')) {
    const verdict = assertAssignableRole(role);
    assert.equal(verdict.ok, true, `${role} must be assignable`);
    assert.equal(verdict.role, role, `${role} must come back unchanged`);
    assert.equal(verdict.error, undefined);
  }
});

test('superadmin is refused by name', () => {
  // Refused by NAME and not merely by the preset check, because `superadmin`
  // IS a ROLE_PRESETS key — the membership check alone lets it through.
  const verdict = assertAssignableRole('superadmin');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.error, 'superadmin cannot be assigned');
  assert.equal(verdict.role, undefined, 'nothing assignable comes back');
});

test('an unknown role string is refused', () => {
  for (const role of ['wizard', 'Owner', 'owner ', 'super admin', 'SUPERADMIN']) {
    const verdict = assertAssignableRole(role);
    assert.equal(verdict.ok, false, `${JSON.stringify(role)} must be refused`);
    assert.equal(verdict.error, 'Unknown role');
  }
});

test('an inherited Object key is not a role', () => {
  for (const role of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(assertAssignableRole(role).ok, false, `${role} must be refused`);
  }
});

test('a non-string role is refused, including an array that coerces to a key', () => {
  // ['owner'] stringifies to 'owner', so a bare hasOwnProperty check accepts it
  // and `roles: [['owner']]` lands in Mongo.
  for (const role of [['owner'], ['superadmin'], { role: 'owner' }, 7, true]) {
    const verdict = assertAssignableRole(role);
    assert.equal(verdict.ok, false, `${JSON.stringify(role)} must be refused`);
    assert.equal(verdict.error, 'Unknown role');
  }
});

test("no role given defaults to 'agent', exactly as the invite route did inline", () => {
  for (const role of [undefined, null, '']) {
    const verdict = assertAssignableRole(role);
    assert.equal(verdict.ok, true, `${JSON.stringify(role)} must be accepted`);
    assert.equal(verdict.role, 'agent');
  }
});

// ---------------------------------------------------------------------------
// The routes — real routers, real auth, in-memory MongoDB.
// ---------------------------------------------------------------------------

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

const dashboardRouter = require('../src/routes/dashboard');
const authRouter = require('../src/routes/auth');
const Entity = require('../src/models/Entity');
const Invite = require('../src/models/Invite');
const User = require('../src/models/User');
const { signAccessToken, isSuperAdmin } = require('../src/middleware/auth');

const DOMAIN = 'bakery.example';
const OTHER = 'other.example';
const HASHED = 'x'.repeat(60);

let mongod, server, baseUrl;
let owner, teammate;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  await Entity.create({ domain: DOMAIN, name: 'The Bakery' });
  await Entity.create({ domain: OTHER, name: 'Somebody Else' });

  // A perfectly ordinary customer: owner of one entity, so USERS_MANAGE and
  // nothing more. This is the account the escalation started from.
  owner = await User.create({
    name: 'Ordinary Owner', email: 'owner@bakery.example', hashedPassword: HASHED,
    memberships: [{ entityDomain: DOMAIN, roles: ['owner'], permissions: [] }],
  });
  teammate = await User.create({
    name: 'Teammate', email: 'teammate@bakery.example', hashedPassword: HASHED,
    memberships: [{ entityDomain: DOMAIN, roles: ['agent'], permissions: [] }],
  });

  const app = express();
  app.use(express.json());
  app.use('/api/dashboard', dashboardRouter);
  app.use('/auth', authRouter);

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const invite = (body) => req('POST', `/api/dashboard/entities/${DOMAIN}/invites`, body, signAccessToken(owner));
const patchRole = (userId, body) =>
  req('PATCH', `/api/dashboard/entities/${DOMAIN}/team/${userId}`, body, signAccessToken(owner));

// --- the invite door -------------------------------------------------------

test('inviting a superadmin is refused and writes no Invite at all', async () => {
  const before = await Invite.countDocuments();

  const res = await invite({ email: 'me-again@bakery.example', role: 'superadmin' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'superadmin cannot be assigned');
  assert.equal(await Invite.countDocuments(), before, 'no row may be left behind to accept later');
  assert.equal(sentEmails.length, 0, 'and nothing was emailed');
});

test('inviting an unknown role is refused and writes no Invite', async () => {
  const before = await Invite.countDocuments();
  const res = await invite({ email: 'wizard@bakery.example', role: 'wizard' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Unknown role');
  assert.equal(await Invite.countDocuments(), before);
});

test('the email check still comes first — a missing email is its own 400', async () => {
  const res = await invite({ role: 'superadmin' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'email is required');
});

test('inviting an agent still returns 201, exactly as before', async () => {
  sentEmails.length = 0;
  const res = await invite({ email: 'newhire@bakery.example', role: 'agent' });

  assert.equal(res.status, 201);
  assert.equal(res.body.role, 'agent');
  assert.equal(res.body.domain, DOMAIN);
  assert.equal(res.body.email, 'newhire@bakery.example');
  assert.ok(res.body.token, 'the invite token is still returned');

  const row = await Invite.findOne({ email: 'newhire@bakery.example' });
  assert.equal(row.role, 'agent');
  assert.equal(sentEmails.length, 1, 'the invite email still goes out');
  assert.match(sentEmails[0].text, /dashboard as agent\./);
});

test("an invite with no role still defaults to 'agent'", async () => {
  const res = await invite({ email: 'noroleasked@bakery.example' });
  assert.equal(res.status, 201);
  assert.equal(res.body.role, 'agent');
  assert.equal((await Invite.findOne({ email: 'noroleasked@bakery.example' })).role, 'agent');
});

// --- the role-change door: behaviour must be unchanged ---------------------

test('PATCH role: superadmin is still refused with the same message', async () => {
  const res = await patchRole(teammate._id, { role: 'superadmin' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'superadmin cannot be assigned');
});

test('PATCH role: an unknown role is still "Unknown role"', async () => {
  const res = await patchRole(teammate._id, { role: 'wizard' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Unknown role');
});

test('PATCH role: a missing role is still "Unknown role", not a silent default', async () => {
  // The invite route defaults when told nothing; a role CHANGE has nothing to
  // default to, and that difference is deliberate.
  for (const body of [{}, { role: '' }, { role: null }]) {
    const res = await patchRole(teammate._id, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} must be a 400`);
    assert.equal(res.body.error, 'Unknown role');
  }
  const fresh = await User.findById(teammate._id);
  assert.deepEqual(fresh.memberships[0].roles.slice(), ['agent'], 'and the role is untouched');
});

test('PATCH role: the role check still runs before the self-change check', async () => {
  // Today a superadmin self-PATCH answers 'superadmin cannot be assigned'
  // rather than 'You cannot change your own role'. Order preserved.
  const res = await patchRole(owner._id, { role: 'superadmin' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'superadmin cannot be assigned');

  const self = await patchRole(owner._id, { role: 'agent' });
  assert.equal(self.status, 400);
  assert.equal(self.body.error, 'You cannot change your own role');
});

test('PATCH role: a legitimate change still goes through', async () => {
  const res = await patchRole(teammate._id, { role: 'readonly' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.roles, ['readonly']);

  const fresh = await User.findById(teammate._id);
  assert.deepEqual(fresh.memberships[0].roles.slice(), ['readonly']);
  assert.equal(isSuperAdmin(fresh), false);
});

// --- the acceptance door: second line of defence ---------------------------

// Written with the model directly, the way a row minted before the first guard
// shipped — or one dropped into Mongo by hand — would look.
async function seedInvite(email, role) {
  const token = `seeded-${role}-${email}`;
  await Invite.create({
    token, domain: DOMAIN, email, role,
    expiresAt: new Date(Date.now() + 86400000),
  });
  return token;
}

const accept = (token, body) => req('POST', `/auth/invite/${token}/accept`, body);

test('a hand-seeded superadmin invite is refused at acceptance for a NEW user', async () => {
  const email = 'brandnew@bakery.example';
  const token = await seedInvite(email, 'superadmin');

  const res = await accept(token, { name: 'Brand New', password: 'correct-horse' });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'superadmin cannot be assigned');
  assert.equal(await User.findOne({ email }), null, 'no account is created');

  const row = await Invite.findOne({ token });
  assert.equal(row.acceptedAt, undefined, 'the invite is left unaccepted, not half-consumed');
  assert.equal(row.role, 'superadmin', 'and is not quietly rewritten');
});

test('a hand-seeded superadmin invite is refused for an EXISTING user, who stays non-super', async () => {
  const email = 'elsewhere@other.example';
  const existing = await User.create({
    name: 'Elsewhere', email, hashedPassword: HASHED,
    memberships: [{ entityDomain: OTHER, roles: ['owner'], permissions: [] }],
  });
  const token = await seedInvite(email, 'superadmin');

  const res = await accept(token, {});

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'superadmin cannot be assigned');
  assert.ok(!res.body.accessToken, 'no session is handed out');

  const fresh = await User.findById(existing._id);
  assert.equal(fresh.memberships.length, 1, 'memberships are untouched');
  assert.equal(fresh.memberships[0].entityDomain, OTHER);
  assert.equal(isSuperAdmin(fresh), false, 'this is the whole point of the item');
  assert.equal((await Invite.findOne({ token })).acceptedAt, undefined);
});

test('an unknown role in a seeded invite is refused at acceptance too', async () => {
  const email = 'seeded-wizard@bakery.example';
  const token = await seedInvite(email, 'wizard');
  const res = await accept(token, { name: 'Wiz', password: 'correct-horse' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Unknown role');
  assert.equal(await User.findOne({ email }), null);
});

test('an ordinary agent invite still accepts and grants the agent role', async () => {
  const email = 'realhire@bakery.example';
  const token = await seedInvite(email, 'agent');

  const res = await accept(token, { name: 'Real Hire', password: 'correct-horse' });

  assert.equal(res.status, 200);
  assert.ok(res.body.accessToken, 'a session is handed out');

  const created = await User.findOne({ email });
  assert.deepEqual(created.memberships[0].roles.slice(), ['agent']);
  assert.equal(created.memberships[0].entityDomain, DOMAIN);
  assert.equal(isSuperAdmin(created), false);
  assert.ok((await Invite.findOne({ token })).acceptedAt, 'and the invite is consumed');
});

// --- the whole escalation, end to end -------------------------------------

test('the two-request path from entity owner to global superadmin is closed', async () => {
  const email = 'owner-alias@bakery.example';

  // Request 1: invite myself as superadmin on my own domain.
  const first = await invite({ email, role: 'superadmin' });
  assert.equal(first.status, 400);

  // Request 2 has nothing to work with: no invite was ever written, so the
  // accept route cannot find a token to redeem.
  const row = await Invite.findOne({ email });
  assert.equal(row, null);

  const everySuper = await User.find({ 'memberships.roles': 'superadmin' });
  assert.equal(everySuper.length, 0, 'nobody in this suite ever became a superadmin');
});
