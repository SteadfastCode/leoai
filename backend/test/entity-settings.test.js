// Entity settings validation on PATCH (LEO-062).
//
// Two halves:
//   1. Pure-function tests on services/entitySettings.validateEntityUpdates —
//      every bound accepted at its edge and rejected just outside it, a string
//      where a number belongs rejected rather than cast, unknown and
//      superadmin-only fields dropped exactly as the allowlist always dropped
//      them. Plus a drift test: the table must cover the route's allowlist.
//   2. The REAL dashboard router driven over HTTP against an in-memory MongoDB
//      (same harness shape as kb-search.test.js / do-not-relay.test.js) —
//      the payload Settings.vue posts today still saves, while
//      `leoRefreshHour: 99` is a 400 that leaves the stored value untouched.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const {
  validateEntityUpdates,
  FIELD_RULES,
  OWNER_FIELDS,
  SUPERADMIN_FIELDS,
} = require('../src/services/entitySettings');

const AS_OWNER = { isSuperAdmin: false };
const AS_SUPER = { isSuperAdmin: true };

// Build { a: { b: value } } from 'a.b', so the edge table below can name nested
// fields the same way a rejection does.
function bodyFor(fieldPath, value) {
  const [head, nested] = fieldPath.split('.');
  return nested ? { [head]: { [nested]: value } } : { [head]: value };
}

function reasonFor(result, fieldPath) {
  const hit = result.rejected.find((r) => r.field === fieldPath);
  return hit ? hit.reason : null;
}

// ---------------------------------------------------------------------------
// Bounds: accepted at the edge, rejected just outside it
// ---------------------------------------------------------------------------

// [field path, value that must be accepted, value that must be rejected, options]
const EDGES = [
  ['leoRefreshHour', 0, -1, AS_OWNER],
  ['leoRefreshHour', 23, 24, AS_OWNER],
  ['dailyVolumeAlert', 0, -1, AS_OWNER],
  ['conversationRetentionDays', 0, -1, AS_OWNER],
  ['crawlSettings.staleDays', 0, -1, AS_OWNER],
  ['handoffFollowUp.intervalHours', 1, 0, AS_OWNER],
  ['handoffFollowUp.intervalHours', 720, 721, AS_OWNER],
  ['handoffFollowUp.maxReminders', 0, -1, AS_OWNER],
  ['unansweredDigest.hourUtc', 0, -1, AS_OWNER],
  ['unansweredDigest.hourUtc', 23, 24, AS_OWNER],
  ['unansweredDigest.dayOfWeek', 0, -1, AS_OWNER],
  ['unansweredDigest.dayOfWeek', 6, 7, AS_OWNER],
  ['weeklyDigest.dayOfWeek', 0, -1, AS_OWNER],
  ['weeklyDigest.dayOfWeek', 6, 7, AS_OWNER],
  ['weeklyDigest.hour', 0, -1, AS_OWNER],
  ['weeklyDigest.hour', 23, 24, AS_OWNER],
  // Superadmin-gated, so they need a superadmin caller to be reachable at all
  ['ragThreshold', 0.5, 0.49, AS_SUPER],
  ['ragThreshold', 0.95, 0.96, AS_SUPER],
  ['lowConfidenceBand', 0, -0.01, AS_SUPER],
  ['lowConfidenceBand', 0.2, 0.21, AS_SUPER],
];

for (const [field, inside, outside, options] of EDGES) {
  test(`${field}: ${inside} accepted, ${outside} rejected`, () => {
    const ok = validateEntityUpdates(bodyFor(field, inside), options);
    assert.deepEqual(ok.rejected, [], `${field}=${inside} must be accepted`);
    assert.deepEqual(ok.updates, bodyFor(field, inside));

    const bad = validateEntityUpdates(bodyFor(field, outside), options);
    assert.equal(bad.rejected.length, 1, `${field}=${outside} must be rejected`);
    assert.equal(bad.rejected[0].field, field);
    assert.ok(bad.rejected[0].reason, 'a rejection carries a reason');
    assert.deepEqual(bad.updates, {}, 'a rejected field never reaches updates');
  });
}

test('a fractional value is rejected where the model stores a whole number', () => {
  assert.equal(validateEntityUpdates({ leoRefreshHour: 3.5 }, AS_OWNER).rejected.length, 1);
  assert.equal(validateEntityUpdates({ dailyVolumeAlert: 0.5 }, AS_OWNER).rejected.length, 1);
  // ragThreshold is genuinely fractional — it must still accept one
  assert.deepEqual(validateEntityUpdates({ ragThreshold: 0.78 }, AS_SUPER).rejected, []);
});

test('leoRefreshFrequency only accepts the model enum', () => {
  for (const value of ['daily', 'weekly']) {
    assert.deepEqual(validateEntityUpdates({ leoRefreshFrequency: value }, AS_OWNER).rejected, []);
  }
  const bad = validateEntityUpdates({ leoRefreshFrequency: 'monthly' }, AS_OWNER);
  assert.equal(bad.rejected.length, 1);
  assert.match(bad.rejected[0].reason, /daily, weekly/);
});

test('unansweredDigest.frequency only accepts the model enum', () => {
  assert.deepEqual(validateEntityUpdates({ unansweredDigest: { frequency: 'daily' } }, AS_OWNER).rejected, []);
  const bad = validateEntityUpdates({ unansweredDigest: { frequency: 'hourly' } }, AS_OWNER);
  assert.equal(reasonFor(bad, 'unansweredDigest.frequency') !== null, true);
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

test('quotaWarningThresholds: percentages 1-99, ascending, no repeats', () => {
  assert.deepEqual(validateEntityUpdates({ quotaWarningThresholds: [50, 75, 90] }, AS_OWNER).rejected, []);
  assert.deepEqual(validateEntityUpdates({ quotaWarningThresholds: [1, 99] }, AS_OWNER).rejected, []);
  // Empty means "fall back to the defaults" in routes/chat.js — still legal.
  assert.deepEqual(validateEntityUpdates({ quotaWarningThresholds: [] }, AS_OWNER).updates,
    { quotaWarningThresholds: [] });

  for (const bad of [[0, 50], [50, 100], [90, 50], [50, 50], [50.5], ['50'], 50]) {
    const result = validateEntityUpdates({ quotaWarningThresholds: bad }, AS_OWNER);
    assert.equal(result.rejected.length, 1, `${JSON.stringify(bad)} must be rejected`);
    assert.deepEqual(result.updates, {});
  }
});

test('quotaAlertChannels is a subset of email/sms', () => {
  for (const ok of [[], ['email'], ['sms'], ['email', 'sms']]) {
    assert.deepEqual(validateEntityUpdates({ quotaAlertChannels: ok }, AS_OWNER).updates,
      { quotaAlertChannels: ok });
  }
  for (const bad of [['push'], ['email', 'carrier-pigeon'], 'email', [1]]) {
    const result = validateEntityUpdates({ quotaAlertChannels: bad }, AS_OWNER);
    assert.equal(result.rejected.length, 1, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('doNotRelay is still sanitised on write, never rejected (LEO-047)', () => {
  const result = validateEntityUpdates(
    { doNotRelay: ['  Salary   questions ', 'salary questions', 7, ''] }, AS_OWNER);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.updates.doNotRelay, ['Salary questions']);
  // A non-array has always been coerced to [], not refused.
  assert.deepEqual(validateEntityUpdates({ doNotRelay: 'salary' }, AS_OWNER),
    { updates: { doNotRelay: [] }, rejected: [] });
});

// ---------------------------------------------------------------------------
// Types: nothing is coerced
// ---------------------------------------------------------------------------

test('a string where a number belongs is rejected, not cast', () => {
  const result = validateEntityUpdates({ leoRefreshHour: '5' }, AS_OWNER);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].field, 'leoRefreshHour');
  assert.match(result.rejected[0].reason, /received text/);
  assert.deepEqual(result.updates, {}, 'nothing is stored');
});

test('a non-boolean where a switch belongs is rejected', () => {
  for (const field of ['autoAddRepliesToKb', 'offerHandoffBeforeContact', 'linksOpenInNewTab']) {
    const result = validateEntityUpdates({ [field]: 'true' }, AS_OWNER);
    assert.equal(result.rejected.length, 1, `${field} must reject the string "true"`);
  }
  assert.deepEqual(validateEntityUpdates({ linksOpenInNewTab: false }, AS_OWNER).updates,
    { linksOpenInNewTab: false });
});

test('null is rejected rather than stored over a defaulted field', () => {
  assert.equal(validateEntityUpdates({ ownerPhone: null }, AS_OWNER).rejected.length, 1);
  assert.equal(validateEntityUpdates({ leoRefreshHour: null }, AS_OWNER).rejected.length, 1);
});

test('strings are trimmed and length-capped', () => {
  assert.deepEqual(validateEntityUpdates({ name: '  Dosie Dough  ' }, AS_OWNER).updates,
    { name: 'Dosie Dough' });
  // name is required: true on the model, so blank can never be stored
  assert.equal(validateEntityUpdates({ name: '   ' }, AS_OWNER).rejected.length, 1);
  const tooLong = validateEntityUpdates({ name: 'x'.repeat(FIELD_RULES.name.max + 1) }, AS_OWNER);
  assert.equal(tooLong.rejected.length, 1);
  assert.match(tooLong.rejected[0].reason, /characters or fewer/);
  // An empty optional string stays legal — a blank owner phone skips that channel
  assert.deepEqual(validateEntityUpdates({ ownerPhone: '' }, AS_OWNER).updates, { ownerPhone: '' });
});

// ---------------------------------------------------------------------------
// Subdocuments
// ---------------------------------------------------------------------------

test('a subdocument field that is not an object is rejected', () => {
  const result = validateEntityUpdates({ crawlSettings: 'yes' }, AS_OWNER);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].field, 'crawlSettings');
});

test('an unknown key inside a subdocument is ignored, the known ones still apply', () => {
  const result = validateEntityUpdates(
    { crawlSettings: { staleDays: 3, keepShortUrls: true, bogus: 1 } }, AS_OWNER);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.updates, { crawlSettings: { staleDays: 3, keepShortUrls: true } });
});

test('one bad key rejects its whole subdocument, writing nothing', () => {
  const result = validateEntityUpdates(
    { crawlSettings: { staleDays: -5, keepShortUrls: true } }, AS_OWNER);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].field, 'crawlSettings.staleDays');
  assert.deepEqual(result.updates, {});
});

test('a partial subdocument is accepted — Settings.vue posts handoffFollowUp without maxReminders', () => {
  const result = validateEntityUpdates(
    { handoffFollowUp: { enabled: true, intervalHours: 24 } }, AS_OWNER);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.updates, { handoffFollowUp: { enabled: true, intervalHours: 24 } });
});

// ---------------------------------------------------------------------------
// The allowlist and the superadmin split
// ---------------------------------------------------------------------------

test('an unknown field is ignored exactly as the allowlist always ignored it', () => {
  const result = validateEntityUpdates(
    { plan: 'lifetime', messageCount: 999999, domain: 'elsewhere.example.com' }, AS_OWNER);
  assert.deepEqual(result, { updates: {}, rejected: [] });
});

test('a superadmin-only field is dropped for a non-superadmin, not rejected', () => {
  // Settings.vue posts ragThreshold for every user; an owner must get a clean
  // 200 with the field simply ignored, which is what it did before LEO-062.
  const result = validateEntityUpdates({ name: 'A Bakery', ragThreshold: 5 }, AS_OWNER);
  assert.deepEqual(result, { updates: { name: 'A Bakery' }, rejected: [] });

  // The same value from a superadmin is out of bounds and must be refused.
  const asSuper = validateEntityUpdates({ ragThreshold: 5 }, AS_SUPER);
  assert.equal(asSuper.rejected.length, 1);
  assert.equal(asSuper.rejected[0].field, 'ragThreshold');
});

test('churchConfig is superadmin-only and its prose fields are capped', () => {
  const dropped = validateEntityUpdates({ churchConfig: { statementOfFaith: 'x' } }, AS_OWNER);
  assert.deepEqual(dropped, { updates: {}, rejected: [] });

  const applied = validateEntityUpdates({ churchConfig: { statementOfFaith: ' We believe ' } }, AS_SUPER);
  assert.deepEqual(applied.updates, { churchConfig: { statementOfFaith: 'We believe' } });

  const tooLong = validateEntityUpdates(
    { churchConfig: { statementOfFaith: 'x'.repeat(20001) } }, AS_SUPER);
  assert.equal(tooLong.rejected[0].field, 'churchConfig.statementOfFaith');
});

test('an empty body yields empty updates and no rejections', () => {
  for (const body of [{}, null, undefined, [], 'nonsense']) {
    assert.deepEqual(validateEntityUpdates(body, AS_OWNER), { updates: {}, rejected: [] });
  }
});

test('every rejection names a field and a reason, and several accumulate', () => {
  const result = validateEntityUpdates(
    { leoRefreshHour: 99, dailyVolumeAlert: -1, name: 'Fine' }, AS_OWNER);
  assert.equal(result.rejected.length, 2);
  assert.deepEqual(result.rejected.map((r) => r.field).sort(), ['dailyVolumeAlert', 'leoRefreshHour']);
  for (const r of result.rejected) assert.equal(typeof r.reason, 'string');
  // The validator still reports the survivors; it is the caller's contract that
  // a non-empty `rejected` means write nothing — proven over HTTP further down.
  assert.deepEqual(result.updates, { name: 'Fine' });
});

// ---------------------------------------------------------------------------
// Drift guard: the table must describe the route's whole allowlist
// ---------------------------------------------------------------------------

test('FIELD_RULES covers exactly the PATCH allowlist in routes/dashboard.js', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'dashboard.js'), 'utf8');
  const names = (label) => {
    const match = source.match(new RegExp(`const ${label} = \\[([^\\]]*)\\]`));
    assert.ok(match, `could not find the ${label} array in routes/dashboard.js`);
    return match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
  };
  assert.deepEqual(names('allowed'), [...OWNER_FIELDS].sort(),
    'a field was added to the route allowlist without a bound in services/entitySettings.js');
  assert.deepEqual(names('superadminOnly'), [...SUPERADMIN_FIELDS].sort(),
    'the superadmin split drifted from services/entitySettings.js');
});

// ---------------------------------------------------------------------------
// The real dashboard router over an in-memory MongoDB
// ---------------------------------------------------------------------------

function stubModule(resolvedPath, exportsObject) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsObject,
  };
}

const srcDir = path.join(__dirname, '..', 'src');

// Fake auth: the x-test-user header carries a JSON user object.
stubModule(require.resolve(path.join(srcDir, 'middleware', 'auth.js')), {
  requireAuth: () => (req, res, next) => {
    const raw = req.headers['x-test-user'];
    if (!raw) return res.status(401).json({ error: 'Unauthorized' });
    req.user = JSON.parse(raw);
    next();
  },
  isSuperAdmin: (user) => !!user?.superadmin,
});

stubModule(require.resolve(path.join(srcDir, 'services', 'embeddings.js')), {
  embedTexts: async () => { throw new Error('embedTexts must not be called in this suite'); },
  embedQuery: async () => { throw new Error('embedQuery must not be called in this suite'); },
});

stubModule(require.resolve(path.join(srcDir, 'services', 'rag.js')), {
  retrieveContext: async () => { throw new Error('retrieveContext must not be called in this suite'); },
});

// Nothing in this suite should send; a call is a test failure, not a real send.
stubModule(require.resolve(path.join(srcDir, 'services', 'email.js')), {
  sendEmailRaw: async () => { throw new Error('no email may be sent from tests'); },
});

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

const dashboardRouter = require('../src/routes/dashboard');
const Entity = require('../src/models/Entity');

let mongod;
let server;
let baseUrl;

const DOMAIN = 'settings.example.com';
const OWNER = JSON.stringify({ memberships: [{ entityDomain: DOMAIN, role: 'owner' }] });
const SUPER = JSON.stringify({ superadmin: true });

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const app = express();
  app.use(express.json());
  app.use('/api/dashboard', dashboardRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await Entity.create({ domain: DOMAIN, name: 'A Bakery' });
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function patchEntity(body, user = OWNER) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers['x-test-user'] = user;
  const res = await fetch(`${baseUrl}/api/dashboard/entities/${DOMAIN}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// Exactly the shape Settings.vue builds in its `watch(() => props.entity)` block,
// including the superadmin-only fields it posts for every user.
function settingsPayload() {
  return {
    name: 'A Bakery',
    timezone: 'America/New_York',
    avgWaitTime: '24 hours',
    ownerPhone: '',
    ownerEmail: '',
    autoAddRepliesToKb: false,
    offerHandoffBeforeContact: true,
    churchModeEnabled: false,
    churchConfig: {
      missionStatement: '',
      statementOfFaith: '',
      denominationalDistinctives: '',
      churchValues: '',
      pastoralToneNotes: '',
    },
    linksOpenInNewTab: true,
    crawlSettings: {
      keepSocialHandles: false,
      keepShortUrls: false,
      variantPriceSweep: false,
      staleDays: 0,
    },
    leoRefreshHour: 3,
    leoRefreshFrequency: 'daily',
    quotaWarningThresholds: [50, 75, 90],
    quotaAlertChannels: ['email'],
    handoffFollowUp: { enabled: true, intervalHours: 24 },
    weeklyDigest: { enabled: false, dayOfWeek: 1, hour: 13 },
    doNotRelay: [],
    conversationRetentionDays: 0,
    ragThreshold: 0.75,
  };
}

test('the payload Settings.vue sends today still saves and returns the entity', async () => {
  const { status, body } = await patchEntity(settingsPayload());
  assert.equal(status, 200);
  assert.equal(body.domain, DOMAIN);
  assert.equal(body.name, 'A Bakery');
  assert.equal(body.leoRefreshHour, 3);
  assert.equal(body.leoRefreshFrequency, 'daily');
  assert.deepEqual([...body.quotaWarningThresholds], [50, 75, 90]);
  assert.deepEqual([...body.quotaAlertChannels], ['email']);
  assert.equal(body.crawlSettings.staleDays, 0);
  assert.equal(body.handoffFollowUp.intervalHours, 24);
  assert.equal(body.weeklyDigest.hour, 13);
  assert.equal(body.conversationRetentionDays, 0);
  // Superadmin-only fields posted by an owner are ignored, not rejected
  assert.equal(body.churchModeEnabled, false);
  assert.equal(body.ragThreshold, 0.75);
});

test('leoRefreshHour: 99 is a 400 and leaves the stored value untouched', async () => {
  const ok = await patchEntity({ leoRefreshHour: 7 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.leoRefreshHour, 7);

  const { status, body } = await patchEntity({ leoRefreshHour: 99 });
  assert.equal(status, 400);
  assert.ok(body.error, 'the 400 carries an error message');
  assert.deepEqual(body.rejected, [{ field: 'leoRefreshHour', reason: 'must be a whole number from 0 to 23' }]);

  const stored = await Entity.findOne({ domain: DOMAIN });
  assert.equal(stored.leoRefreshHour, 7, 'the out-of-range write never landed');
});

test('a whole patch is refused when one field is out of range', async () => {
  await patchEntity({ name: 'A Bakery', avgWaitTime: '24 hours' });
  const { status } = await patchEntity({ avgWaitTime: '2 hours', leoRefreshHour: -1 });
  assert.equal(status, 400);

  const stored = await Entity.findOne({ domain: DOMAIN });
  assert.equal(stored.avgWaitTime, '24 hours', 'the valid field in a rejected patch is not written');
});

test('a non-numeric value is a 400, not the old 500 with a raw driver message', async () => {
  const { status, body } = await patchEntity({ leoRefreshHour: 'three' });
  assert.equal(status, 400);
  assert.equal(body.rejected.length, 1);
  assert.ok(!/cast/i.test(JSON.stringify(body)), 'no CastError text reaches the owner');
});

test('ragThreshold: 5 is refused for a superadmin and ignored for an owner', async () => {
  const asSuper = await patchEntity({ ragThreshold: 5 }, SUPER);
  assert.equal(asSuper.status, 400);

  const asOwner = await patchEntity({ ragThreshold: 5 });
  assert.equal(asOwner.status, 200);
  assert.equal(asOwner.body.ragThreshold, 0.75, 'still the default — an owner cannot set it at all');

  const applied = await patchEntity({ ragThreshold: 0.8 }, SUPER);
  assert.equal(applied.status, 200);
  assert.equal(applied.body.ragThreshold, 0.8);
});

test('a body with no recognised field is still a no-op 200', async () => {
  const { status, body } = await patchEntity({ plan: 'lifetime', messageCount: 999999 });
  assert.equal(status, 200);
  assert.equal(body.plan, 'free');
  assert.equal(body.messageCount, 0);
});

test('a member of another entity still cannot patch this one', async () => {
  const other = JSON.stringify({ memberships: [{ entityDomain: 'b.example.com' }] });
  const { status } = await patchEntity({ leoRefreshHour: 4 }, other);
  assert.equal(status, 403);
});
