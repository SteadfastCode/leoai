// Visitor "forget me" + conversation retention (LEO-043).
//
// This is the destructive item in the queue, so the tests that matter are the
// SCOPING ones: they drive the real forgetConversation/runRetentionSweepTick
// against an in-memory MongoDB seeded with neighbouring conversations, and
// assert the neighbours survive. The pure predicates cover the 0/disabled,
// exactly-N-days, and just-past-N-days boundaries without a DB.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const Conversation = require('../src/models/Conversation');
const Entity = require('../src/models/Entity');
const {
  forgetFilter,
  retentionCutoff,
  isExpired,
  sweepFilter,
  sweepDue,
  forgetConversation,
  runRetentionSweepTick,
  SWEEP_HOUR_UTC,
} = require('../src/services/retention');

const DAY = 24 * 60 * 60 * 1000;
const MINE = 'retention-a.leo-nightly.test';
const THEIRS = 'retention-b.leo-nightly.test';

// --- forgetFilter: the delete filter can never widen ------------------------

test('forgetFilter: both halves present → exact two-key equality filter', () => {
  assert.deepEqual(forgetFilter(MINE, 'tok_1'), { domain: MINE, sessionToken: 'tok_1' });
});

test('forgetFilter: a missing sessionToken yields null, never a domain-wide filter', () => {
  assert.equal(forgetFilter(MINE, undefined), null);
  assert.equal(forgetFilter(MINE, ''), null);
  assert.equal(forgetFilter(MINE, '   '), null);
});

test('forgetFilter: a missing domain yields null', () => {
  assert.equal(forgetFilter(undefined, 'tok_1'), null);
  assert.equal(forgetFilter('', 'tok_1'), null);
});

test('forgetFilter: non-string input (mongo operator injection) yields null', () => {
  assert.equal(forgetFilter(MINE, { $ne: null }), null);
  assert.equal(forgetFilter({ $ne: null }, 'tok_1'), null);
  assert.equal(forgetFilter(MINE, ['tok_1']), null);
});

// --- retentionCutoff / isExpired: the age boundary --------------------------

test('retentionCutoff: 0 / unset / negative / junk all disable retention', () => {
  const now = Date.parse('2026-09-10T04:00:00Z');
  assert.equal(retentionCutoff({ conversationRetentionDays: 0 }, now), null);
  assert.equal(retentionCutoff({}, now), null);
  assert.equal(retentionCutoff(undefined, now), null);
  assert.equal(retentionCutoff({ conversationRetentionDays: -30 }, now), null);
  assert.equal(retentionCutoff({ conversationRetentionDays: 'soon' }, now), null);
});

test('retentionCutoff: N days back from now', () => {
  const now = Date.parse('2026-09-10T04:00:00Z');
  assert.equal(
    retentionCutoff({ conversationRetentionDays: 30 }, now).toISOString(),
    new Date(now - 30 * DAY).toISOString()
  );
});

test('isExpired: retention disabled keeps a conversation of any age', () => {
  const now = Date.now();
  const ancient = { lastActiveAt: new Date(now - 900 * DAY) };
  assert.equal(isExpired(ancient, { conversationRetentionDays: 0 }, now), false);
  assert.equal(isExpired(ancient, {}, now), false);
});

test('isExpired: exactly N days old is NOT older than N days — kept', () => {
  const now = Date.now();
  const convo = { lastActiveAt: new Date(now - 30 * DAY) };
  assert.equal(isExpired(convo, { conversationRetentionDays: 30 }, now), false);
});

test('isExpired: one second past N days is expired', () => {
  const now = Date.now();
  const convo = { lastActiveAt: new Date(now - 30 * DAY - 1000) };
  assert.equal(isExpired(convo, { conversationRetentionDays: 30 }, now), true);
});

test('isExpired: one second short of N days is kept', () => {
  const now = Date.now();
  const convo = { lastActiveAt: new Date(now - 30 * DAY + 1000) };
  assert.equal(isExpired(convo, { conversationRetentionDays: 30 }, now), false);
});

test('isExpired: an unresolved handoff is never swept', () => {
  const now = Date.now();
  const convo = { lastActiveAt: new Date(now - 400 * DAY), handoffPending: true };
  assert.equal(isExpired(convo, { conversationRetentionDays: 30 }, now), false);
});

test('isExpired: falls back to updatedAt, and keeps a conversation with no timestamp at all', () => {
  const now = Date.now();
  assert.equal(isExpired({ updatedAt: new Date(now - 90 * DAY) }, { conversationRetentionDays: 30 }, now), true);
  assert.equal(isExpired({}, { conversationRetentionDays: 30 }, now), false);
  assert.equal(isExpired({ lastActiveAt: 'not a date' }, { conversationRetentionDays: 30 }, now), false);
});

test('sweepFilter: always domain-scoped, handoff-excluded, and strictly older than the cutoff', () => {
  const cutoff = new Date('2026-08-11T04:00:00Z');
  assert.deepEqual(sweepFilter(MINE, cutoff), {
    domain: MINE,
    handoffPending: { $ne: true },
    lastActiveAt: { $lt: cutoff },
  });
});

// --- sweepDue: hour gate ----------------------------------------------------

test('sweepDue: only inside the sweep hour', () => {
  const inHour = Date.parse(`2026-09-10T${String(SWEEP_HOUR_UTC).padStart(2, '0')}:07:00Z`);
  assert.equal(sweepDue(inHour, 0), true);
  assert.equal(sweepDue(inHour + 60 * 60 * 1000, 0), false);
});

test('sweepDue: a second fire in the same hour is suppressed, the next day is not', () => {
  const inHour = Date.parse(`2026-09-10T${String(SWEEP_HOUR_UTC).padStart(2, '0')}:07:00Z`);
  assert.equal(sweepDue(inHour + 60 * 1000, inHour), false);
  assert.equal(sweepDue(inHour + DAY, inHour), true);
});

// --- DB: deletion is strictly scoped ---------------------------------------

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

test.after(async () => {
  await Conversation.deleteMany({ domain: { $in: [MINE, THEIRS] } });
  await Entity.deleteMany({ domain: { $in: [MINE, THEIRS] } });
  await mongoose.disconnect();
  await mongod.stop();
});

async function seed() {
  await Conversation.deleteMany({ domain: { $in: [MINE, THEIRS] } });
  await Entity.deleteMany({ domain: { $in: [MINE, THEIRS] } });
  await Conversation.create([
    { domain: MINE, sessionToken: 'tok_mine', messages: [{ role: 'user', content: 'hi' }] },
    { domain: MINE, sessionToken: 'tok_neighbour', messages: [{ role: 'user', content: 'also hi' }] },
    { domain: THEIRS, sessionToken: 'tok_mine', messages: [{ role: 'user', content: 'other tenant' }] },
  ]);
}

const tokensFor = async (domain) =>
  (await Conversation.find({ domain }).select('sessionToken').lean()).map((c) => c.sessionToken).sort();

test('forget: deletes only the caller’s own domain+sessionToken', async () => {
  await seed();
  assert.equal(await forgetConversation({ domain: MINE, sessionToken: 'tok_mine' }), 1);

  // The other visitor on the same domain survives...
  assert.deepEqual(await tokensFor(MINE), ['tok_neighbour']);
  // ...and so does the SAME token on a different domain.
  assert.deepEqual(await tokensFor(THEIRS), ['tok_mine']);
});

test('forget: a mismatched token deletes nothing', async () => {
  await seed();
  assert.equal(await forgetConversation({ domain: MINE, sessionToken: 'tok_not_mine' }), 0);
  assert.deepEqual(await tokensFor(MINE), ['tok_mine', 'tok_neighbour']);
  assert.deepEqual(await tokensFor(THEIRS), ['tok_mine']);
});

test('forget: a missing token refuses (null) and deletes nothing', async () => {
  await seed();
  assert.equal(await forgetConversation({ domain: MINE }), null);
  assert.equal(await forgetConversation({ domain: MINE, sessionToken: '' }), null);
  assert.equal(await forgetConversation({}), null);
  assert.deepEqual(await tokensFor(MINE), ['tok_mine', 'tok_neighbour']);
});

test('forget: an operator-shaped token cannot match every row', async () => {
  await seed();
  assert.equal(await forgetConversation({ domain: MINE, sessionToken: { $ne: null } }), null);
  assert.deepEqual(await tokensFor(MINE), ['tok_mine', 'tok_neighbour']);
});

// --- DB: the sweep ----------------------------------------------------------

const AT_SWEEP_HOUR = Date.parse(`2026-09-10T${String(SWEEP_HOUR_UTC).padStart(2, '0')}:05:00Z`);

async function seedForSweep({ mineDays, theirsDays }) {
  await Conversation.deleteMany({ domain: { $in: [MINE, THEIRS] } });
  await Entity.deleteMany({ domain: { $in: [MINE, THEIRS] } });
  await Entity.create([
    { domain: MINE, name: 'Mine', conversationRetentionDays: mineDays },
    { domain: THEIRS, name: 'Theirs', conversationRetentionDays: theirsDays },
  ]);
  await Conversation.create([
    { domain: MINE, sessionToken: 'old', lastActiveAt: new Date(AT_SWEEP_HOUR - 90 * DAY), messages: [] },
    { domain: MINE, sessionToken: 'exactly_30', lastActiveAt: new Date(AT_SWEEP_HOUR - 30 * DAY), messages: [] },
    { domain: MINE, sessionToken: 'recent', lastActiveAt: new Date(AT_SWEEP_HOUR - 2 * DAY), messages: [] },
    { domain: MINE, sessionToken: 'old_handoff', lastActiveAt: new Date(AT_SWEEP_HOUR - 90 * DAY), handoffPending: true, messages: [] },
    { domain: THEIRS, sessionToken: 'old', lastActiveAt: new Date(AT_SWEEP_HOUR - 900 * DAY), messages: [] },
  ]);
}

test('sweep: deletes only what is strictly older than the entity’s own window', async () => {
  await seedForSweep({ mineDays: 30, theirsDays: 0 });

  const result = await runRetentionSweepTick(AT_SWEEP_HOUR);
  assert.equal(result.ran, true);
  assert.equal(result.deleted, 1);

  // exactly-30-days is kept (boundary), recent is kept, the pending handoff is kept.
  assert.deepEqual(await tokensFor(MINE), ['exactly_30', 'old_handoff', 'recent']);
  // The entity with retention disabled keeps a 900-day-old conversation.
  assert.deepEqual(await tokensFor(THEIRS), ['old']);
});

test('sweep: no-ops outside the sweep hour', async () => {
  await seedForSweep({ mineDays: 1, theirsDays: 1 });
  const result = await runRetentionSweepTick(AT_SWEEP_HOUR + 3 * 60 * 60 * 1000);
  assert.deepEqual(result, { ran: false, deleted: 0, entities: 0 });
  assert.equal(await Conversation.countDocuments({ domain: { $in: [MINE, THEIRS] } }), 5);
});

test('sweep: with every entity at 0, nothing is ever deleted', async () => {
  await seedForSweep({ mineDays: 0, theirsDays: 0 });
  const result = await runRetentionSweepTick(AT_SWEEP_HOUR + DAY);
  assert.equal(result.ran, true);
  assert.equal(result.deleted, 0);
  assert.equal(result.entities, 0);
  assert.equal(await Conversation.countDocuments({ domain: { $in: [MINE, THEIRS] } }), 5);
});
