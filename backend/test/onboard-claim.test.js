// Domain claim + alpha-code consumption at signup (LEO-108).
//
// POST /auth/onboard rejected a duplicate EMAIL and nothing else. It then wrote
// `memberships: [{ entityDomain: domain, roles: ['owner'] }]` and an
// `Entity.findOneAndUpdate({ domain }, { $set: { ownerEmail, ... } },
// { upsert: true })`, so a second holder of a valid alpha code could sign up
// naming a live entity's domain, receive `owner` on it, and have the `$set`
// rewrite the `ownerEmail` that every handoff SMS/email and quota warning is
// sent to. A second person joining an existing entity goes through invites.
//
// Second defect in the same block: the single-use cap was READ before the user
// was created and WRITTEN after the tokens, so two signups in the same tick
// both passed a `maxUses: 1` check, and a throw in between burned no use.
//
// The pure rules run with no DB; the route tests drive the REAL auth router
// over HTTP against in-memory MongoDB, with the notifications service stubbed
// (auth.js pulls sendEmailRaw for password reset; the real one drags in
// twilio/resend clients).
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

stubModule(require.resolve(path.join(srcDir, 'services', 'notifications.js')), {
  sendEmailRaw: async () => {},
});

const {
  normalizeDomain,
  claimCheck,
  describeCodeRefusal,
  codeConsumeFilter,
} = require('../src/services/onboard');

// ---------------------------------------------------------------------------
// Pure rules — no database
// ---------------------------------------------------------------------------

test('normalizeDomain reduces a typed URL to the entity identity', () => {
  assert.equal(normalizeDomain('HTTPS://WWW.Example.com/path:8080'), 'example.com');
  assert.equal(normalizeDomain('https://example.com:8080/path?x=1#f'), 'example.com');
  assert.equal(normalizeDomain('  http://Shop.Example.co.uk/  '), 'shop.example.co.uk');
  assert.equal(normalizeDomain('www.example.com.'), 'example.com');
});

test('normalizeDomain leaves an already-bare hostname alone', () => {
  assert.equal(normalizeDomain('example.com'), 'example.com');
  assert.equal(normalizeDomain('shop.example.com'), 'shop.example.com');
  assert.equal(normalizeDomain('my-bakery.example.com'), 'my-bakery.example.com');
});

test('normalizeDomain rejects anything that is not a hostname, without throwing', () => {
  for (const bad of ['', '   ', 'not a domain', null, undefined, 42, {}, [],
    'localhost', 'https://', 'http:///path', '-example.com', 'example', '.com',
    'exa mple.com', 'user:pass@example.com']) {
    assert.equal(normalizeDomain(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('claimCheck refuses a domain that already has an entity or a member', () => {
  const entity = claimCheck({ entityExists: true, memberExists: false });
  assert.equal(entity.ok, false);
  assert.equal(entity.status, 409);
  assert.match(entity.error, /invite/i);

  const member = claimCheck({ entityExists: false, memberExists: true });
  assert.equal(member.ok, false);
  assert.equal(member.status, 409);

  // Same message either way — which of the two is true is nobody's business.
  assert.equal(member.error, entity.error);
});

test('claimCheck passes an unclaimed domain', () => {
  assert.deepEqual(claimCheck({ entityExists: false, memberExists: false }), { ok: true });
  assert.deepEqual(claimCheck({}), { ok: true });
  assert.deepEqual(claimCheck(), { ok: true });
});

test('describeCodeRefusal names why the consume found no slot', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  assert.equal(describeCodeRefusal(null, now).reason, 'unknown');
  assert.equal(describeCodeRefusal(null, now).status, 403);
  assert.equal(describeCodeRefusal({ active: false, maxUses: null }, now).reason, 'inactive');
  assert.equal(
    describeCodeRefusal({ active: true, expiresAt: new Date('2026-01-01'), maxUses: null }, now).reason,
    'expired',
  );
  assert.equal(describeCodeRefusal({ active: true, maxUses: 1, useCount: 1 }, now).reason, 'exhausted');
  // Satisfies every condition on re-read: a concurrent signup took the slot.
  assert.equal(describeCodeRefusal({ active: true, maxUses: 2, useCount: 0 }, now).reason, 'raced');
  // Unlimited code that is active and unexpired can only be the raced case.
  assert.equal(describeCodeRefusal({ active: true, maxUses: null, useCount: 99 }, now).reason, 'raced');
});

test('codeConsumeFilter carries type, active, cap and expiry', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const f = codeConsumeFilter('ALPHA-1', now);
  assert.equal(f.code, 'ALPHA-1');
  assert.equal(f.type, 'alpha');
  assert.equal(f.active, true);
  assert.equal(f.$and.length, 2);
  assert.deepEqual(f.$and[0].$or[0], { maxUses: null });
  assert.deepEqual(f.$and[0].$or[1], { $expr: { $lt: ['$useCount', '$maxUses'] } });
  assert.deepEqual(f.$and[1].$or, [{ expiresAt: null }, { expiresAt: { $gt: now } }]);
});

// ---------------------------------------------------------------------------
// The real route over in-memory MongoDB
// ---------------------------------------------------------------------------

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

const authRouter = require('../src/routes/auth');
const User = require('../src/models/User');
const Code = require('../src/models/Code');
const Entity = require('../src/models/Entity');

test('POST /auth/onboard claim guard', async (t) => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const onboard = (body) => fetch(`${baseUrl}/auth/onboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const signup = (over = {}) => ({
    name: 'Signer',
    email: 'signer@example.com',
    password: 'longenough1',
    alphaCode: 'ALPHA-OPEN',
    domain: 'fresh.example.com',
    businessName: 'Fresh Biz',
    ...over,
  });

  await Code.create({ code: 'ALPHA-OPEN', type: 'alpha', active: true, maxUses: null });

  await t.test('an unclaimed domain still onboards exactly as before', async () => {
    const r = await onboard(signup({ email: 'first@example.com', domain: 'fresh.example.com' }));
    assert.equal(r.status, 201);
    const j = await r.json();
    assert.ok(j.accessToken && j.refreshToken, 'tokens are returned');

    const entity = await Entity.findOne({ domain: 'fresh.example.com' }).lean();
    assert.ok(entity, 'Entity created');
    assert.equal(entity.ownerEmail, 'first@example.com');
    assert.equal(entity.name, 'Fresh Biz');

    const user = await User.findOne({ email: 'first@example.com' }).lean();
    assert.deepEqual(user.memberships.map((m) => ({ d: m.entityDomain, r: m.roles })), [
      { d: 'fresh.example.com', r: ['owner'] },
    ]);
  });

  await t.test('a domain with a live Entity is refused, and its ownerEmail survives', async () => {
    const before = await Entity.findOne({ domain: 'fresh.example.com' }).lean();

    const r = await onboard(signup({ email: 'thief@example.com', domain: 'fresh.example.com' }));
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /invite/i);

    assert.equal(await User.countDocuments({ email: 'thief@example.com' }), 0, 'no User created');
    const after = await Entity.findOne({ domain: 'fresh.example.com' }).lean();
    assert.equal(after.ownerEmail, before.ownerEmail, 'ownerEmail untouched');
    assert.equal(after.ownerPhone, before.ownerPhone);
  });

  await t.test('the same domain typed as a URL with www. is refused too', async () => {
    const r = await onboard(signup({ email: 'thief2@example.com', domain: 'https://WWW.Fresh.example.com/contact' }));
    assert.equal(r.status, 409);
    assert.equal(await User.countDocuments({ email: 'thief2@example.com' }), 0);
  });

  await t.test('a domain held only by a membership, with no Entity, is refused', async () => {
    // The Entity document was deleted but the team is still around.
    await User.create({
      name: 'Orphan Owner',
      email: 'orphan@example.com',
      hashedPassword: 'x',
      memberships: [{ entityDomain: 'orphan.example.com', roles: ['owner'], permissions: [] }],
    });
    assert.equal(await Entity.countDocuments({ domain: 'orphan.example.com' }), 0);

    const r = await onboard(signup({ email: 'thief3@example.com', domain: 'orphan.example.com' }));
    assert.equal(r.status, 409);
    assert.equal(await User.countDocuments({ email: 'thief3@example.com' }), 0);
    assert.equal(await Entity.countDocuments({ domain: 'orphan.example.com' }), 0, 'no Entity upserted');
  });

  await t.test('an unparseable domain is a 400 and creates nothing', async () => {
    const r = await onboard(signup({ email: 'bad@example.com', domain: 'not a domain' }));
    assert.equal(r.status, 400);
    assert.equal(await User.countDocuments({ email: 'bad@example.com' }), 0);
    assert.equal(await Entity.countDocuments({}), 1, 'only the one entity from the first subtest');
  });

  await t.test('a refused signup does not burn an alpha-code use', async () => {
    await Code.create({ code: 'ALPHA-ONE', type: 'alpha', active: true, maxUses: 1 });

    // Refused on the domain claim, after the code was already spent.
    const r = await onboard(signup({ email: 'burn@example.com', domain: 'fresh.example.com', alphaCode: 'ALPHA-ONE' }));
    assert.equal(r.status, 409);
    const released = await Code.findOne({ code: 'ALPHA-ONE' }).lean();
    assert.equal(released.useCount, 0, 'use released');
    assert.deepEqual(released.usedBy.map((u) => u.email), [], 'usedBy entry removed');

    // ...so the code is still good for the signup it was meant for.
    const ok = await onboard(signup({ email: 'burn@example.com', domain: 'burn.example.com', alphaCode: 'ALPHA-ONE' }));
    assert.equal(ok.status, 201);
    const spent = await Code.findOne({ code: 'ALPHA-ONE' }).lean();
    assert.equal(spent.useCount, 1);
    assert.deepEqual(spent.usedBy.map((u) => u.email), ['burn@example.com']);
  });

  await t.test('a spent single-use code is refused', async () => {
    const r = await onboard(signup({ email: 'late@example.com', domain: 'late.example.com', alphaCode: 'ALPHA-ONE' }));
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /already been used/i);
    assert.equal(await User.countDocuments({ email: 'late@example.com' }), 0);
  });

  await t.test('two signups in the same tick on a maxUses:1 code yield one 201 and one 403', async () => {
    await Code.create({ code: 'ALPHA-RACE', type: 'alpha', active: true, maxUses: 1 });

    const [a, b] = await Promise.all([
      onboard(signup({ email: 'racer-a@example.com', domain: 'racer-a.example.com', alphaCode: 'ALPHA-RACE' })),
      onboard(signup({ email: 'racer-b@example.com', domain: 'racer-b.example.com', alphaCode: 'ALPHA-RACE' })),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 403], `expected one 201 and one 403, got ${statuses.join(',')}`);

    const code = await Code.findOne({ code: 'ALPHA-RACE' }).lean();
    assert.equal(code.useCount, 1, 'the cap held');
    assert.equal(code.usedBy.length, 1);
    assert.equal(
      await User.countDocuments({ email: { $in: ['racer-a@example.com', 'racer-b@example.com'] } }),
      1,
      'exactly one account exists',
    );
  });

  await t.test('an expired code is refused by the consume filter itself', async () => {
    await Code.create({
      code: 'ALPHA-OLD', type: 'alpha', active: true, maxUses: null,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const r = await onboard(signup({ email: 'old@example.com', domain: 'old.example.com', alphaCode: 'ALPHA-OLD' }));
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /expired/i);
    assert.equal((await Code.findOne({ code: 'ALPHA-OLD' }).lean()).useCount, 0);
  });

  await mongoose.disconnect();
  await mongod.stop();
  server.close();
});
