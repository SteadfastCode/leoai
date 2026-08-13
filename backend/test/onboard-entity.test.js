// Entity creation at signup (LEO-022).
//
// POST /auth/onboard used to create only the User + membership; the Entity was
// first upserted when a scrape SUCCEEDED. Until then handoff SMS/email and
// quota warnings had no recipient, and a failed first crawl left the account
// with no Entity at all. Now onboard upserts the Entity with ownerEmail from
// the signup email, plus optional ownerPhone and quotaAlertChannels.
//
// Drives the REAL auth router over HTTP against in-memory MongoDB, with the
// notifications service stubbed (auth.js pulls sendEmailRaw for the password
// reset flow; requiring the real one would drag in twilio/resend clients).
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

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

const authRouter = require('../src/routes/auth');
const User = require('../src/models/User');
const Code = require('../src/models/Code');
const Entity = require('../src/models/Entity');

let mongod;
let server;
let baseUrl;

const onboard = (body) => fetch(`${baseUrl}/auth/onboard`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('onboard creates the Entity', async (t) => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await Code.create({ code: 'ALPHA-TEST', type: 'alpha', active: true, maxUses: null });

  await t.test('signup upserts Entity with ownerEmail, phone, channels, and name', async () => {
    const r = await onboard({
      name: 'Daniel Test',
      email: 'owner@example.com',
      password: 'longenough1',
      alphaCode: 'ALPHA-TEST',
      domain: 'bakery.example.com',
      businessName: 'Example Bakery',
      ownerPhone: '+17175550123',
      quotaAlertChannels: ['email', 'sms'],
    });
    assert.equal(r.status, 201);
    const j = await r.json();
    assert.ok(j.accessToken && j.refreshToken);

    const entity = await Entity.findOne({ domain: 'bakery.example.com' }).lean();
    assert.ok(entity, 'Entity must exist immediately after onboard, before any scrape');
    assert.equal(entity.ownerEmail, 'owner@example.com');
    assert.equal(entity.ownerPhone, '+17175550123');
    assert.deepEqual(entity.quotaAlertChannels, ['email', 'sms']);
    assert.equal(entity.name, 'Example Bakery');
  });

  await t.test('duplicate email still 409s and does not clobber the entity', async () => {
    const r = await onboard({
      name: 'Someone Else',
      email: 'owner@example.com',
      password: 'longenough1',
      alphaCode: 'ALPHA-TEST',
      domain: 'other.example.com',
      businessName: 'Other Biz',
    });
    assert.equal(r.status, 409);
    assert.equal(await User.countDocuments({ email: 'owner@example.com' }), 1);
    assert.equal(await Entity.countDocuments({ domain: 'other.example.com' }), 0);
  });

  await t.test('optional fields omitted: Entity still created with ownerEmail, defaults intact', async () => {
    const r = await onboard({
      name: 'Minimal Signup',
      email: 'minimal@example.com',
      password: 'longenough1',
      alphaCode: 'ALPHA-TEST',
      domain: 'minimal.example.com',
    });
    assert.equal(r.status, 201);
    const entity = await Entity.findOne({ domain: 'minimal.example.com' }).lean();
    assert.ok(entity);
    assert.equal(entity.ownerEmail, 'minimal@example.com');
    assert.equal(entity.ownerPhone, '');
    assert.deepEqual(entity.quotaAlertChannels, ['email']); // model default
  });

  await t.test('bogus channel values are filtered, not stored', async () => {
    const r = await onboard({
      name: 'Filter Test',
      email: 'filter@example.com',
      password: 'longenough1',
      alphaCode: 'ALPHA-TEST',
      domain: 'filter.example.com',
      quotaAlertChannels: ['carrier-pigeon', 'sms'],
    });
    assert.equal(r.status, 201);
    const entity = await Entity.findOne({ domain: 'filter.example.com' }).lean();
    assert.deepEqual(entity.quotaAlertChannels, ['sms']);
  });

  await t.test('pre-existing Entity keeps its name; ownerEmail is set', async () => {
    // e.g. superadmin pre-created the entity, or a prior scrape named it.
    await Entity.create({ domain: 'named.example.com', name: 'Curated Name' });
    const r = await onboard({
      name: 'Late Owner',
      email: 'late@example.com',
      password: 'longenough1',
      alphaCode: 'ALPHA-TEST',
      domain: 'named.example.com',
      businessName: 'Should Not Overwrite',
    });
    assert.equal(r.status, 201);
    const entity = await Entity.findOne({ domain: 'named.example.com' }).lean();
    assert.equal(entity.name, 'Curated Name'); // $setOnInsert only
    assert.equal(entity.ownerEmail, 'late@example.com');
  });

  await mongoose.disconnect();
  await mongod.stop();
  server.close();
});
