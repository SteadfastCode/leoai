// Nested-subdocument merge on the settings PATCH (LEO-076).
//
// Two halves:
//   1. Pure-function tests on services/entityUpdates.flattenEntityUpdates.
//   2. The REAL dashboard router driven over HTTP against an in-memory MongoDB
//      (same harness shape as do-not-relay.test.js / kb-search.test.js), proving
//      a partial body no longer resets the siblings it did not name. External
//      services are stubbed via require.cache before the router loads, so no
//      Claude/Voyage/Twilio/Resend call can ever fire.
//
// The integration half is the one that goes red against unmodified `main`: the
// old route `$set` each subdocument as a whole value.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

// Keep the suite's output to the test reporter, not the flattener's debug line.
process.env.ENTITY_UPDATES_LOG_LEVEL = 'off';

const { flattenEntityUpdates } = require('../src/services/entityUpdates');
const { FIELD_RULES } = require('../src/services/entitySettings');

// ---------------------------------------------------------------------------
// flattenEntityUpdates — the shape of what reaches Mongoose
// ---------------------------------------------------------------------------

test('one nested key yields one dot-path and nothing else', () => {
  assert.deepEqual(
    flattenEntityUpdates({ crawlSettings: { keepShortUrls: true } }),
    { 'crawlSettings.keepShortUrls': true }
  );
});

test('the whole subdocument key never survives alongside its dot-paths', () => {
  // A stray `crawlSettings` key in the update would $set the whole value and
  // undo the entire point of this module.
  const flat = flattenEntityUpdates({ crawlSettings: { keepShortUrls: true, staleDays: 14 } });
  assert.deepEqual(Object.keys(flat).sort(), ['crawlSettings.keepShortUrls', 'crawlSettings.staleDays']);
  assert.ok(!('crawlSettings' in flat));
});

test('an undeclared nested key is dropped', () => {
  // honorRobots is on the model (LEO-071) but not on the PATCH field table, so
  // it is not settable here — and must not be written as a dot-path either.
  assert.deepEqual(
    flattenEntityUpdates({ crawlSettings: { keepShortUrls: true, honorRobots: true } }),
    { 'crawlSettings.keepShortUrls': true }
  );
  assert.deepEqual(flattenEntityUpdates({ crawlSettings: { nope: 1, alsoNope: 2 } }), {});
});

test('a nested key is never taken from the body verbatim — no path injection', () => {
  // Keys come from the declared table, so a dotted or $-prefixed body key can
  // neither become a path nor reach an operator position.
  assert.deepEqual(
    flattenEntityUpdates({ crawlSettings: { 'staleDays.$[]': 1, $unset: { keepShortUrls: '' }, 'a.b': 2 } }),
    {}
  );
});

test('a non-object value for a subdocument key is dropped rather than spread', () => {
  for (const bad of ['text', 42, true, null, ['keepShortUrls'], undefined]) {
    assert.deepEqual(flattenEntityUpdates({ crawlSettings: bad }), {},
      `a ${typeof bad} crawlSettings must not reach the update`);
  }
});

test('arrays survive whole', () => {
  const updates = {
    quotaWarningThresholds: [50, 75, 90],
    quotaAlertChannels: ['email', 'sms'],
    doNotRelay: ['Salary questions'],
  };
  const flat = flattenEntityUpdates(updates);
  assert.deepEqual(flat, updates);
  // Merging a list by index would leave a removed trailing entry behind.
  assert.deepEqual(flattenEntityUpdates({ quotaWarningThresholds: [50, 75] }),
    { quotaWarningThresholds: [50, 75] });
  assert.deepEqual(flattenEntityUpdates({ quotaAlertChannels: [] }), { quotaAlertChannels: [] });
});

test('scalars pass through under their own key', () => {
  const updates = {
    name: 'A Bakery',
    leoRefreshHour: 3,
    linksOpenInNewTab: false,
    ragThreshold: 0.8,
    conversationRetentionDays: 0,
  };
  assert.deepEqual(flattenEntityUpdates(updates), updates);
});

test('an empty body yields empty updates', () => {
  assert.deepEqual(flattenEntityUpdates({}), {});
  assert.deepEqual(flattenEntityUpdates({ crawlSettings: {} }), {});
  assert.deepEqual(flattenEntityUpdates({ crawlSettings: {}, handoffFollowUp: {} }), {});
});

test('a non-object update yields empty updates', () => {
  for (const bad of [undefined, null, 'name', 42, ['name']]) {
    assert.deepEqual(flattenEntityUpdates(bad), {});
  }
});

test('an undefined value is skipped, never turned into a wipe', () => {
  // Mongoose reads an undefined dot-path as an $unset — the exact silent wipe
  // this module exists to prevent.
  assert.deepEqual(flattenEntityUpdates({ name: undefined, leoRefreshHour: 3 }), { leoRefreshHour: 3 });
  assert.deepEqual(
    flattenEntityUpdates({ crawlSettings: { keepShortUrls: true, staleDays: undefined } }),
    { 'crawlSettings.keepShortUrls': true }
  );
});

test('every subdocument on the field table is flattened, not just crawlSettings', () => {
  const subdocs = Object.keys(FIELD_RULES).filter((k) => FIELD_RULES[k].type === 'object');
  assert.ok(subdocs.length >= 4, `expected the known subdocuments, got ${subdocs.join(', ')}`);
  for (const field of subdocs) {
    const [firstKey] = Object.keys(FIELD_RULES[field].fields);
    const flat = flattenEntityUpdates({ [field]: { [firstKey]: 0 } });
    assert.deepEqual(flat, { [`${field}.${firstKey}`]: 0 },
      `${field} must flatten to a dot-path`);
  }
});

test('mixed body: subdocuments flatten while everything else is untouched', () => {
  assert.deepEqual(
    flattenEntityUpdates({
      name: 'A Bakery',
      crawlSettings: { staleDays: 7 },
      handoffFollowUp: { enabled: false },
      quotaWarningThresholds: [60],
    }),
    {
      name: 'A Bakery',
      'crawlSettings.staleDays': 7,
      'handoffFollowUp.enabled': false,
      quotaWarningThresholds: [60],
    }
  );
});

test('a field the table does not describe passes through whole', () => {
  // Mirrors validateEntityUpdates, which stores an undescribed allowlisted
  // field unvalidated rather than dropping the owner's setting.
  assert.deepEqual(flattenEntityUpdates({ someFutureField: { a: 1 } }), { someFutureField: { a: 1 } });
});

test('false and 0 are written, not treated as absent', () => {
  assert.deepEqual(
    flattenEntityUpdates({ crawlSettings: { keepShortUrls: false, staleDays: 0 } }),
    { 'crawlSettings.keepShortUrls': false, 'crawlSettings.staleDays': 0 }
  );
});

test('the input object is not mutated', () => {
  const updates = { crawlSettings: { keepShortUrls: true }, name: 'A Bakery' };
  const before = JSON.stringify(updates);
  flattenEntityUpdates(updates);
  assert.equal(JSON.stringify(updates), before);
});

// ---------------------------------------------------------------------------
// The real router, over an in-memory MongoDB
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

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-used';

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

const dashboardRouter = require('../src/routes/dashboard');
const Entity = require('../src/models/Entity');

let mongod;
let server;
let baseUrl;

const DOMAIN = 'a.example.com';
const OWNER = JSON.stringify({ memberships: [{ entityDomain: DOMAIN, role: 'owner' }] });
const SUPER = JSON.stringify({ superadmin: true, memberships: [{ entityDomain: DOMAIN, role: 'owner' }] });

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

// Writes a value the PATCH path cannot set, the way LeoRefresh or a script does.
async function setOutOfBand(update) {
  await Entity.updateOne({ domain: DOMAIN }, { $set: update });
}

test('a partial crawlSettings body leaves its unnamed siblings alone', async () => {
  await setOutOfBand({
    'crawlSettings.keepSocialHandles': true,
    'crawlSettings.variantPriceSweep': true,
    'crawlSettings.staleDays': 14,
    'crawlSettings.keepShortUrls': false,
  });

  const { status, body } = await patchEntity({ crawlSettings: { keepShortUrls: true } });
  assert.equal(status, 200);
  assert.equal(body.crawlSettings.keepShortUrls, true, 'the named key is written');
  assert.equal(body.crawlSettings.variantPriceSweep, true, 'variantPriceSweep must survive');
  assert.equal(body.crawlSettings.staleDays, 14, 'staleDays must survive');
  assert.equal(body.crawlSettings.keepSocialHandles, true, 'keepSocialHandles must survive');

  const stored = await Entity.findOne({ domain: DOMAIN }).lean();
  assert.deepEqual(stored.crawlSettings, {
    keepSocialHandles: true,
    keepShortUrls: true,
    variantPriceSweep: true,
    honorRobots: false,
    staleDays: 14,
  });
});

test('a flag set out of band survives the full payload Settings.vue sends', async () => {
  // The LEO-065 grader's case, from the other end: honorRobots (LEO-071) is on
  // the model but absent from Settings.vue's 4-key crawlSettings literal, so
  // the old whole-value $set reset it on every owner save.
  await setOutOfBand({ 'crawlSettings.honorRobots': true, 'handoffFollowUp.maxReminders': 7 });

  const { status, body } = await patchEntity({
    crawlSettings: {
      keepSocialHandles: false,
      keepShortUrls: false,
      variantPriceSweep: false,
      staleDays: 0,
    },
    handoffFollowUp: { enabled: true, intervalHours: 24 },
  });
  assert.equal(status, 200);
  assert.equal(body.crawlSettings.honorRobots, true,
    'honorRobots is not settable here and must not be resettable here either');
  assert.equal(body.handoffFollowUp.maxReminders, 7,
    'maxReminders is absent from the dashboard payload and must survive it');
  // The keys the body DID name are still written.
  assert.equal(body.crawlSettings.staleDays, 0);
  assert.equal(body.crawlSettings.keepSocialHandles, false);
  assert.equal(body.handoffFollowUp.intervalHours, 24);
});

test('the full payload Settings.vue sends today returns the entity unchanged', async () => {
  const before = await Entity.findOne({ domain: DOMAIN }).lean();

  // Exactly the shape dashboard/src/views/Settings.vue rebuilds, fed back from
  // the entity it just loaded. Superadmin-only keys are included because the
  // form posts them; an owner's write drops them, as it always did.
  const payload = {
    name: before.name,
    timezone: before.timezone,
    avgWaitTime: before.avgWaitTime,
    ownerPhone: before.ownerPhone,
    ownerEmail: before.ownerEmail,
    autoAddRepliesToKb: before.autoAddRepliesToKb,
    offerHandoffBeforeContact: before.offerHandoffBeforeContact ?? true,
    churchModeEnabled: before.churchModeEnabled,
    churchConfig: {
      missionStatement: before.churchConfig?.missionStatement || '',
      statementOfFaith: before.churchConfig?.statementOfFaith || '',
      denominationalDistinctives: before.churchConfig?.denominationalDistinctives || '',
      churchValues: before.churchConfig?.churchValues || '',
      pastoralToneNotes: before.churchConfig?.pastoralToneNotes || '',
    },
    linksOpenInNewTab: before.linksOpenInNewTab ?? true,
    crawlSettings: {
      keepSocialHandles: before.crawlSettings?.keepSocialHandles ?? false,
      keepShortUrls: before.crawlSettings?.keepShortUrls ?? false,
      variantPriceSweep: before.crawlSettings?.variantPriceSweep ?? false,
      staleDays: before.crawlSettings?.staleDays ?? 0,
    },
    leoRefreshHour: before.leoRefreshHour ?? 3,
    leoRefreshFrequency: before.leoRefreshFrequency ?? 'daily',
    quotaWarningThresholds: before.quotaWarningThresholds ?? [50, 75, 90],
    quotaAlertChannels: before.quotaAlertChannels ?? ['email'],
    handoffFollowUp: {
      enabled: before.handoffFollowUp?.enabled ?? true,
      intervalHours: before.handoffFollowUp?.intervalHours ?? 24,
    },
    weeklyDigest: {
      enabled: before.weeklyDigest?.enabled ?? false,
      dayOfWeek: before.weeklyDigest?.dayOfWeek ?? 1,
      hour: before.weeklyDigest?.hour ?? 13,
    },
    doNotRelay: [...(before.doNotRelay || [])],
    conversationRetentionDays: before.conversationRetentionDays ?? 0,
    ragThreshold: before.ragThreshold ?? 0.75,
  };

  const { status } = await patchEntity(payload);
  assert.equal(status, 200);

  const after = await Entity.findOne({ domain: DOMAIN }).lean();
  for (const key of ['crawlSettings', 'handoffFollowUp', 'unansweredDigest', 'weeklyDigest', 'churchConfig']) {
    assert.deepEqual(after[key], before[key], `${key} must be byte-identical after a no-op save`);
  }
  assert.deepEqual(after.quotaWarningThresholds, before.quotaWarningThresholds);
  assert.deepEqual(after.quotaAlertChannels, before.quotaAlertChannels);
  assert.equal(after.name, before.name);
  assert.equal(after.ragThreshold, before.ragThreshold);
});

test('a subdocument the body never mentions is not touched at all', async () => {
  await setOutOfBand({ 'unansweredDigest.enabled': true, 'unansweredDigest.hourUtc': 9 });
  const { status, body } = await patchEntity({ crawlSettings: { staleDays: 3 } });
  assert.equal(status, 200);
  assert.equal(body.unansweredDigest.enabled, true);
  assert.equal(body.unansweredDigest.hourUtc, 9);
  assert.equal(body.crawlSettings.staleDays, 3);
});

test('a nested key outside its bounds still rejects the whole write', async () => {
  // The LEO-062 gate runs before the flattener; nothing may be written.
  const before = await Entity.findOne({ domain: DOMAIN }).lean();
  const { status, body } = await patchEntity({
    crawlSettings: { keepShortUrls: true, staleDays: -5 },
  });
  assert.equal(status, 400);
  assert.ok(body.rejected.some((r) => r.field === 'crawlSettings.staleDays'));
  const after = await Entity.findOne({ domain: DOMAIN }).lean();
  assert.deepEqual(after.crawlSettings, before.crawlSettings, 'a rejected write stores nothing');
});

test('an undeclared nested key is ignored without disturbing the subdocument', async () => {
  await setOutOfBand({ 'crawlSettings.honorRobots': true });
  const { status, body } = await patchEntity({
    crawlSettings: { keepShortUrls: true, honorRobots: false, madeUp: 'x' },
  });
  assert.equal(status, 200);
  assert.equal(body.crawlSettings.honorRobots, true, 'an undeclared key cannot be set through PATCH');
  assert.equal(body.crawlSettings.keepShortUrls, true);
  assert.equal(body.crawlSettings.madeUp, undefined);
});

test('a superadmin partial churchConfig keeps the fields it did not name', async () => {
  await patchEntity({
    churchConfig: {
      missionStatement: 'To know Christ and make Him known.',
      statementOfFaith: 'We believe in one God, eternally existent in three persons.',
      denominationalDistinctives: 'Elder-led congregational governance.',
      churchValues: 'Scripture, prayer, hospitality.',
      pastoralToneNotes: 'Warm, unhurried, never pushy.',
    },
  }, SUPER);

  const { status, body } = await patchEntity({
    churchConfig: { pastoralToneNotes: 'Warm and direct.' },
  }, SUPER);
  assert.equal(status, 200);
  assert.equal(body.churchConfig.pastoralToneNotes, 'Warm and direct.');
  assert.equal(body.churchConfig.statementOfFaith,
    'We believe in one God, eternally existent in three persons.',
    'a statement of faith must never be wiped by an unrelated save');
  assert.equal(body.churchConfig.missionStatement, 'To know Christ and make Him known.');
  assert.equal(body.churchConfig.churchValues, 'Scripture, prayer, hospitality.');
});

test('an owner still cannot reach a superadmin subdocument', async () => {
  const before = await Entity.findOne({ domain: DOMAIN }).lean();
  const { status, body } = await patchEntity({
    churchConfig: { statementOfFaith: 'injected by an owner' },
    ragThreshold: 0.51,
  });
  assert.equal(status, 200);
  assert.equal(body.churchConfig.statementOfFaith, before.churchConfig.statementOfFaith);
  assert.equal(body.ragThreshold, before.ragThreshold);
});

test('an empty subdocument writes nothing and clears nothing', async () => {
  const before = await Entity.findOne({ domain: DOMAIN }).lean();
  const { status, body } = await patchEntity({ crawlSettings: {} });
  assert.equal(status, 200);
  assert.deepEqual(body.crawlSettings, {
    keepSocialHandles: before.crawlSettings.keepSocialHandles,
    keepShortUrls: before.crawlSettings.keepShortUrls,
    variantPriceSweep: before.crawlSettings.variantPriceSweep,
    honorRobots: before.crawlSettings.honorRobots,
    staleDays: before.crawlSettings.staleDays,
  });
});

test('an unlisted top-level field is still ignored by the PATCH allowlist', async () => {
  const { status, body } = await patchEntity({
    crawlSettings: { staleDays: 5 },
    plan: 'lifetime',
    messageCount: 999999,
  });
  assert.equal(status, 200);
  assert.equal(body.plan, 'free', 'plan must not be settable by an owner');
  assert.equal(body.messageCount, 0);
  assert.equal(body.crawlSettings.staleDays, 5);
});

test('a member of another entity cannot patch this one', async () => {
  const other = JSON.stringify({ memberships: [{ entityDomain: 'b.example.com' }] });
  const { status } = await patchEntity({ crawlSettings: { staleDays: 1 } }, other);
  assert.equal(status, 403);
});
