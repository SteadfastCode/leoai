// Visitor "forget me" + conversation retention (LEO-043).
//
// Three halves, in order of how much they matter:
//   1. The REAL chat router driven over HTTP against an in-memory MongoDB:
//      POST /chat/forget must delete the caller's own conversation and NOTHING
//      else — a mismatched token deletes nothing, another domain's identical
//      token is untouched. This is a destructive endpoint, so this is the test
//      that counts.
//   2. The pure delete-filter builders: a malformed request must never widen
//      into a filter that matches more than it was asked to. `{}` passed to
//      deleteMany empties the collection, so null-vs-{} is the whole point.
//   3. The pure retention predicate: off/disabled, exactly-N-days, and the
//      boundary either side of it, plus the real sweep over the DB — including
//      the exemption for a handoff the owner has not answered yet.
//
// Claude/Voyage/Twilio/Resend are stubbed via require.cache before the routers
// load, so no external call — and in particular no notification — can fire.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const srcDir = path.join(__dirname, '..', 'src');

function stubModule(resolvedPath, exportsObject) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsObject,
  };
}

// Nothing in this suite talks to a model, an index, or a person.
stubModule(require.resolve(path.join(srcDir, 'services', 'claude.js')), {
  chat: async () => { throw new Error('chat must not be called in this suite'); },
  classifyQuery: async () => { throw new Error('classifyQuery must not be called in this suite'); },
  summarizeTopic: async () => { throw new Error('summarizeTopic must not be called in this suite'); },
});
stubModule(require.resolve(path.join(srcDir, 'services', 'rag.js')), {
  retrieveContext: async () => { throw new Error('retrieveContext must not be called in this suite'); },
});
stubModule(require.resolve(path.join(srcDir, 'services', 'embeddings.js')), {
  embedTexts: async () => { throw new Error('embedTexts must not be called in this suite'); },
  embedQuery: async () => { throw new Error('embedQuery must not be called in this suite'); },
});
stubModule(require.resolve(path.join(srcDir, 'services', 'notifications.js')), {
  sendHandoffNotification: async () => { throw new Error('no notification may be sent from tests'); },
  sendQuotaWarning: async () => { throw new Error('no notification may be sent from tests'); },
  sendQuotaExceededNotification: async () => { throw new Error('no notification may be sent from tests'); },
});
stubModule(require.resolve(path.join(srcDir, 'services', 'email.js')), {
  sendEmailRaw: async () => { throw new Error('no email may be sent from tests'); },
});

// Fake auth for the dashboard router: the x-test-user header carries a JSON
// user object (same shape as do-not-relay.test.js).
stubModule(require.resolve(path.join(srcDir, 'middleware', 'auth.js')), {
  requireAuth: () => (req, res, next) => {
    const raw = req.headers['x-test-user'];
    if (!raw) return res.status(401).json({ error: 'Unauthorized' });
    req.user = JSON.parse(raw);
    next();
  },
  isSuperAdmin: (user) => !!user?.superadmin,
});

const {
  retentionDays,
  retentionCutoff,
  conversationExpired,
  forgetFilter,
  sweepFilter,
  lastActivityAt,
  runRetentionSweepTick,
  SWEEP_HOUR_UTC,
  DAY_MS,
} = require('../src/services/retention');

// ---------------------------------------------------------------------------
// Pure: the delete-filter builders. A widened filter here is data loss.
// ---------------------------------------------------------------------------

test('forgetFilter builds an exact domain+sessionToken pair', () => {
  assert.deepEqual(
    forgetFilter({ domain: 'a.example.com', sessionToken: 'leo_abc' }),
    { domain: 'a.example.com', sessionToken: 'leo_abc' }
  );
});

test('forgetFilter trims surrounding whitespace on both halves', () => {
  assert.deepEqual(
    forgetFilter({ domain: ' a.example.com ', sessionToken: ' leo_abc\n' }),
    { domain: 'a.example.com', sessionToken: 'leo_abc' }
  );
});

test('forgetFilter returns null — never {} — for anything unusable', () => {
  // deleteMany({}) empties the collection, so each of these MUST be null.
  for (const bad of [
    undefined,
    {},
    { domain: 'a.example.com' },
    { sessionToken: 'leo_abc' },
    { domain: '', sessionToken: 'leo_abc' },
    { domain: 'a.example.com', sessionToken: '' },
    { domain: 'a.example.com', sessionToken: '   ' },
    { domain: 'a.example.com', sessionToken: { $ne: null } },
    { domain: { $ne: null }, sessionToken: 'leo_abc' },
    { domain: 'a.example.com', sessionToken: 7 },
  ]) {
    assert.equal(forgetFilter(bad), null, `must refuse ${JSON.stringify(bad)}`);
  }
});

test('sweepFilter is scoped to one domain and only to documents older than the cutoff', () => {
  const cutoff = new Date('2026-09-01T00:00:00Z');
  const f = sweepFilter('a.example.com', cutoff);
  assert.equal(f.domain, 'a.example.com');
  assert.deepEqual(f.handoffPending, { $ne: true }, 'unanswered handoffs are exempt');
  assert.deepEqual(f.$or, [
    { lastActiveAt: { $lt: cutoff } },
    { lastActiveAt: { $exists: false }, createdAt: { $lt: cutoff } },
  ]);
});

test('sweepFilter returns null for a missing domain or an unusable cutoff', () => {
  const cutoff = new Date('2026-09-01T00:00:00Z');
  assert.equal(sweepFilter('', cutoff), null);
  assert.equal(sweepFilter(undefined, cutoff), null);
  assert.equal(sweepFilter('a.example.com', null), null);
  assert.equal(sweepFilter('a.example.com', new Date('nonsense')), null);
  assert.equal(sweepFilter('a.example.com', Date.now()), null, 'a number is not a Date');
});

// ---------------------------------------------------------------------------
// Pure: retention window — disabled, exactly N days, and the boundary
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-10-12T12:00:00Z');
const convo = (lastActiveAt) => ({ sessionToken: 'leo_abc', domain: 'a.example.com', lastActiveAt });

test('retentionDays treats 0, absent, negative and junk as keep-forever', () => {
  assert.equal(retentionDays({ conversationRetentionDays: 0 }), 0);
  assert.equal(retentionDays({}), 0);
  assert.equal(retentionDays(undefined), 0);
  assert.equal(retentionDays({ conversationRetentionDays: -30 }), 0);
  assert.equal(retentionDays({ conversationRetentionDays: 'thirty' }), 0);
  assert.equal(retentionDays({ conversationRetentionDays: NaN }), 0);
  assert.equal(retentionDays({ conversationRetentionDays: 30 }), 30);
});

test('retentionCutoff is null when retention is off, N days back when on', () => {
  assert.equal(retentionCutoff({ conversationRetentionDays: 0 }, NOW), null);
  assert.equal(retentionCutoff({}, NOW), null);
  assert.equal(
    retentionCutoff({ conversationRetentionDays: 30 }, NOW).toISOString(),
    new Date(NOW - 30 * DAY_MS).toISOString()
  );
});

test('retention off: nothing ever expires, however old', () => {
  const ancient = convo(new Date(NOW - 5000 * DAY_MS));
  assert.equal(conversationExpired(ancient, { conversationRetentionDays: 0 }, NOW), false);
  assert.equal(conversationExpired(ancient, {}, NOW), false);
  assert.equal(conversationExpired(ancient, undefined, NOW), false);
});

test('exactly N days old: NOT expired — the window is inclusive of its own edge', () => {
  const entity = { conversationRetentionDays: 30 };
  assert.equal(conversationExpired(convo(new Date(NOW - 30 * DAY_MS)), entity, NOW), false);
});

test('one millisecond past N days: expired', () => {
  const entity = { conversationRetentionDays: 30 };
  assert.equal(conversationExpired(convo(new Date(NOW - 30 * DAY_MS - 1)), entity, NOW), true);
});

test('one millisecond short of N days: not expired', () => {
  const entity = { conversationRetentionDays: 30 };
  assert.equal(conversationExpired(convo(new Date(NOW - 30 * DAY_MS + 1)), entity, NOW), false);
});

test('a conversation used this morning never expires under a 1-day window', () => {
  assert.equal(
    conversationExpired(convo(new Date(NOW - 60 * 60 * 1000)), { conversationRetentionDays: 1 }, NOW),
    false
  );
});

test('age is measured from last activity, not creation', () => {
  const entity = { conversationRetentionDays: 7 };
  const old_but_live = {
    createdAt: new Date(NOW - 400 * DAY_MS),
    lastActiveAt: new Date(NOW - 1 * DAY_MS),
  };
  assert.equal(conversationExpired(old_but_live, entity, NOW), false);
  assert.equal(lastActivityAt(old_but_live).getTime(), NOW - 1 * DAY_MS);
});

test('no usable timestamp at all: never expired on a guess', () => {
  const entity = { conversationRetentionDays: 1 };
  assert.equal(conversationExpired({}, entity, NOW), false);
  assert.equal(conversationExpired({ lastActiveAt: new Date('nonsense') }, entity, NOW), false);
  assert.equal(lastActivityAt({}), null);
  assert.equal(lastActivityAt(undefined), null);
});

test('an unanswered handoff is exempt from the sweep, however old', () => {
  const entity = { conversationRetentionDays: 30 };
  const stale = { lastActiveAt: new Date(NOW - 400 * DAY_MS) };
  assert.equal(conversationExpired({ ...stale, handoffPending: true }, entity, NOW), false,
    'the owner still owes this visitor an answer');
  assert.equal(conversationExpired({ ...stale, handoffPending: false }, entity, NOW), true,
    'an answered one ages out normally');
});

test('a document predating lastActiveAt falls back to createdAt', () => {
  const entity = { conversationRetentionDays: 30 };
  assert.equal(conversationExpired({ createdAt: new Date(NOW - 90 * DAY_MS) }, entity, NOW), true);
  assert.equal(conversationExpired({ createdAt: new Date(NOW - 2 * DAY_MS) }, entity, NOW), false);
});

// ---------------------------------------------------------------------------
// The real POST /chat/forget over HTTP, and the real sweep, against Mongo
// ---------------------------------------------------------------------------

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

const chatRouter = require('../src/routes/chat');
const dashboardRouter = require('../src/routes/dashboard');
const Conversation = require('../src/models/Conversation');
const Entity = require('../src/models/Entity');

let mongod;
let server;
let baseUrl;

const MINE = 'leo_mine_0001';
const THEIRS = 'leo_theirs_0002';
const DOMAIN = 'a.example.com';
const OTHER_DOMAIN = 'b.example.com';

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const app = express();
  app.use(express.json());
  app.use('/chat', chatRouter);
  app.use('/api/dashboard', dashboardRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await Conversation.deleteMany({ domain: { $in: [DOMAIN, OTHER_DOMAIN] } });
  await Entity.deleteMany({ domain: { $in: [DOMAIN, OTHER_DOMAIN] } });
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function seedConversations() {
  await Conversation.deleteMany({ domain: { $in: [DOMAIN, OTHER_DOMAIN] } });
  await Conversation.create([
    { domain: DOMAIN, sessionToken: MINE, messages: [{ role: 'user', content: 'mine' }] },
    { domain: DOMAIN, sessionToken: THEIRS, messages: [{ role: 'user', content: 'theirs' }] },
    // Same token, different site — a token is only ever meaningful per domain.
    { domain: OTHER_DOMAIN, sessionToken: MINE, messages: [{ role: 'user', content: 'other site' }] },
  ]);
}

async function postForget(body) {
  const res = await fetch(`${baseUrl}/chat/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const survivors = async () =>
  (await Conversation.find({ domain: { $in: [DOMAIN, OTHER_DOMAIN] } }).lean())
    .map((c) => `${c.domain}/${c.sessionToken}`)
    .sort();

test.beforeEach(seedConversations);

test('forget deletes ONLY the caller\'s own domain+sessionToken', async () => {
  const { status, body } = await postForget({ domain: DOMAIN, sessionToken: MINE });
  assert.equal(status, 200);
  assert.equal(body.deleted, 1);
  assert.equal(body.forgotten, true);

  assert.deepEqual(await survivors(), [
    `${DOMAIN}/${THEIRS}`,
    `${OTHER_DOMAIN}/${MINE}`,
  ], 'another visitor on this site, and the same token on another site, both survive');
});

test('a mismatched session token deletes nothing', async () => {
  const { status, body } = await postForget({ domain: DOMAIN, sessionToken: 'leo_not_a_real_token' });
  assert.equal(status, 200);
  assert.equal(body.deleted, 0);
  assert.equal(body.forgotten, false);
  assert.equal((await survivors()).length, 3, 'all three conversations are untouched');
});

test('a token that belongs to another domain deletes nothing on this one', async () => {
  const { status, body } = await postForget({ domain: OTHER_DOMAIN, sessionToken: THEIRS });
  assert.equal(status, 200);
  assert.equal(body.deleted, 0);
  assert.equal((await survivors()).length, 3);
});

test('forget is idempotent — a second call is a 200 that deletes nothing', async () => {
  await postForget({ domain: DOMAIN, sessionToken: MINE });
  const { status, body } = await postForget({ domain: DOMAIN, sessionToken: MINE });
  assert.equal(status, 200);
  assert.equal(body.deleted, 0);
  assert.equal((await survivors()).length, 2);
});

test('a visitor can forget a conversation with an unanswered handoff', async () => {
  // The sweep exempts these; the person's own request does not have to.
  await Conversation.updateOne({ domain: DOMAIN, sessionToken: MINE }, { handoffPending: true });
  const { status, body } = await postForget({ domain: DOMAIN, sessionToken: MINE });
  assert.equal(status, 200);
  assert.equal(body.deleted, 1);
});

test('a missing half is a 400 and deletes nothing', async () => {
  for (const body of [{}, { domain: DOMAIN }, { sessionToken: MINE }, { domain: DOMAIN, sessionToken: '' }]) {
    const res = await postForget(body);
    assert.equal(res.status, 400, `must reject ${JSON.stringify(body)}`);
  }
  assert.equal((await survivors()).length, 3, 'no rejected request deleted anything');
});

test('an operator-shaped session token cannot widen the delete', async () => {
  // Mongo would happily match every document for { $ne: null }; the filter
  // builder refuses the request instead.
  const { status } = await postForget({ domain: DOMAIN, sessionToken: { $ne: null } });
  assert.equal(status, 200);
  assert.equal((await survivors()).length, 3, 'nothing was deleted');
});

// --- the sweep ---------------------------------------------------------------

const SWEEP_NOW = Date.parse('2026-10-12T05:00:00Z'); // the sweep's UTC hour
const OFF_HOUR_NOW = Date.parse('2026-10-12T06:00:00Z');

async function seedForSweep() {
  await Conversation.deleteMany({ domain: { $in: [DOMAIN, OTHER_DOMAIN] } });
  await Entity.deleteMany({ domain: { $in: [DOMAIN, OTHER_DOMAIN] } });
  await Entity.create([
    { domain: DOMAIN, name: 'A Bakery', conversationRetentionDays: 30 },
    { domain: OTHER_DOMAIN, name: 'B Church', conversationRetentionDays: 0 }, // retention off
  ]);
  await Conversation.create([
    { domain: DOMAIN, sessionToken: 'leo_fresh', lastActiveAt: new Date(SWEEP_NOW - 2 * DAY_MS), messages: [] },
    { domain: DOMAIN, sessionToken: 'leo_edge', lastActiveAt: new Date(SWEEP_NOW - 30 * DAY_MS), messages: [] },
    { domain: DOMAIN, sessionToken: 'leo_stale', lastActiveAt: new Date(SWEEP_NOW - 31 * DAY_MS), messages: [] },
    { domain: DOMAIN, sessionToken: 'leo_unanswered', lastActiveAt: new Date(SWEEP_NOW - 400 * DAY_MS), handoffPending: true, messages: [] },
    { domain: OTHER_DOMAIN, sessionToken: 'leo_ancient', lastActiveAt: new Date(SWEEP_NOW - 900 * DAY_MS), messages: [] },
  ]);
}

test('the sweep deletes past-threshold conversations only for entities that opted in', async () => {
  await seedForSweep();
  const deleted = await runRetentionSweepTick(SWEEP_NOW);
  assert.equal(deleted, 1);
  assert.deepEqual(await survivors(), [
    `${DOMAIN}/leo_edge`,    // exactly 30 days: survives this tick
    `${DOMAIN}/leo_fresh`,
    `${DOMAIN}/leo_unanswered`,    // handoff the owner never answered: exempt
    `${OTHER_DOMAIN}/leo_ancient`, // retention off: never swept, at any age
  ]);
});

test('the sweep is a daily job — it is a no-op in every other UTC hour', async () => {
  await seedForSweep();
  assert.equal(await runRetentionSweepTick(OFF_HOUR_NOW), 0);
  assert.equal((await survivors()).length, 5, 'nothing deleted outside the sweep hour');
  assert.equal(new Date(SWEEP_NOW).getUTCHours(), SWEEP_HOUR_UTC);
});

test('the sweep does nothing when no entity has retention enabled', async () => {
  await seedForSweep();
  await Entity.updateMany({ domain: DOMAIN }, { conversationRetentionDays: 0 });
  assert.equal(await runRetentionSweepTick(SWEEP_NOW), 0);
  assert.equal((await survivors()).length, 5);
});

// --- the setting is actually reachable from the dashboard --------------------

test('an owner can set conversationRetentionDays through the entity PATCH', async () => {
  await Entity.deleteMany({ domain: DOMAIN });
  await Entity.create({ domain: DOMAIN, name: 'A Bakery' });

  const res = await fetch(`${baseUrl}/api/dashboard/entities/${DOMAIN}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-test-user': JSON.stringify({ memberships: [{ entityDomain: DOMAIN, role: 'owner' }] }),
    },
    body: JSON.stringify({ conversationRetentionDays: 90 }),
  });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).conversationRetentionDays, 90);
  const stored = await Entity.findOne({ domain: DOMAIN }).lean();
  assert.equal(stored.conversationRetentionDays, 90, 'an omitted allowlist entry would silently drop this');
});

test('a brand-new entity keeps conversations forever by default', async () => {
  await Entity.deleteMany({ domain: OTHER_DOMAIN });
  const fresh = await Entity.create({ domain: OTHER_DOMAIN, name: 'B Church' });
  assert.equal(fresh.conversationRetentionDays, 0);
  assert.equal(retentionCutoff(fresh, NOW), null);
});
