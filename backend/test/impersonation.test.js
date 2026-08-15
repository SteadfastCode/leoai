// Superadmin impersonation (LEO-045) — exercises the REAL requireAuth middleware over HTTP
// against an in-memory MongoDB with real User documents. Impersonation rewires req.user on
// every authenticated route, so the safety properties below are load-bearing:
//   - the header is INERT for anyone who is not a superadmin
//   - an unresolvable target falls through to the real user (never denies, never escalates)
//   - the permission gate applies to the TARGET, so "view as" shows their denials too
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

const User = require('../src/models/User');
const { requireAuth, signAccessToken } = require('../src/middleware/auth');
const { PERMISSIONS } = require('../src/models/Permission');

const DOMAIN = 'mine.example';
let mongod, server, baseUrl;
let superadmin, owner, readonly;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const hp = 'x'.repeat(60);
  superadmin = await User.create({ name: 'Super', email: 'super@x.invalid', hashedPassword: hp,
    memberships: [{ entityDomain: 'steadfastcode.tech', roles: ['superadmin'], permissions: [] }] });
  owner = await User.create({ name: 'Owner', email: 'owner@x.invalid', hashedPassword: hp,
    memberships: [{ entityDomain: DOMAIN, roles: ['owner'], permissions: [] }] });
  readonly = await User.create({ name: 'Reader', email: 'reader@x.invalid', hashedPassword: hp,
    memberships: [{ entityDomain: DOMAIN, roles: ['readonly'], permissions: [] }] });

  const app = express();
  app.use(express.json());
  // Echoes the EFFECTIVE identity + the real impersonator (if any).
  app.get('/who/:domain', requireAuth(), (req, res) =>
    res.json({ userId: req.user._id.toString(), email: req.user.email, impersonator: req.impersonator?.email ?? null }));
  // Gated route: requires SETTINGS_EDIT for :domain.
  app.get('/settings/:domain', requireAuth(PERMISSIONS.SETTINGS_EDIT), (req, res) => res.json({ ok: true }));

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

function get(path, token, impersonateId) {
  const headers = { Authorization: `Bearer ${token}` };
  if (impersonateId) headers['X-Impersonate-User'] = impersonateId;
  return fetch(`${baseUrl}${path}`, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

test('no impersonation header: the real user is used, impersonator is null', async () => {
  const r = await get(`/who/${DOMAIN}`, signAccessToken(owner));
  assert.equal(r.body.userId, owner._id.toString());
  assert.equal(r.body.impersonator, null);
});

test('superadmin + X-Impersonate-User: req.user becomes the target, impersonator is the superadmin', async () => {
  const r = await get(`/who/${DOMAIN}`, signAccessToken(superadmin), owner._id.toString());
  assert.equal(r.body.userId, owner._id.toString(), 'effective user is the target');
  assert.equal(r.body.email, 'owner@x.invalid');
  assert.equal(r.body.impersonator, 'super@x.invalid', 'the real superadmin is recorded');
});

test('the header is INERT for a non-superadmin', async () => {
  // Owner tries to impersonate readonly — must be silently ignored.
  const r = await get(`/who/${DOMAIN}`, signAccessToken(owner), readonly._id.toString());
  assert.equal(r.body.userId, owner._id.toString(), 'non-superadmin stays themselves');
  assert.equal(r.body.impersonator, null);
});

test('an unresolvable target falls through to the real superadmin (never denies)', async () => {
  const r = await get(`/who/${DOMAIN}`, signAccessToken(superadmin), '000000000000000000000000');
  assert.equal(r.status, 200);
  assert.equal(r.body.userId, superadmin._id.toString(), 'bad target → real user, not a 4xx');
  assert.equal(r.body.impersonator, null);
});

test('the permission gate applies to the TARGET — impersonating a readonly user is blocked', async () => {
  // Superadmin, no impersonation → bypasses the gate.
  const sa = await get(`/settings/${DOMAIN}`, signAccessToken(superadmin));
  assert.equal(sa.status, 200, 'superadmin bypasses the permission gate');

  // Superadmin impersonating the readonly user → blocked, because the target lacks SETTINGS_EDIT.
  const asReadonly = await get(`/settings/${DOMAIN}`, signAccessToken(superadmin), readonly._id.toString());
  assert.equal(asReadonly.status, 403, 'view-as-readonly sees the readonly user\'s denial');

  // Superadmin impersonating the owner → allowed, because the owner has SETTINGS_EDIT.
  const asOwner = await get(`/settings/${DOMAIN}`, signAccessToken(superadmin), owner._id.toString());
  assert.equal(asOwner.status, 200, 'view-as-owner has the owner\'s permissions');
});
