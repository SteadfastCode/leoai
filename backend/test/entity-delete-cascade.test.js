// Entity cascade delete (LEO-105).
//
// Drives the REAL dashboard router over HTTP against an in-memory MongoDB
// (same harness shape as kb-search.test.js / do-not-relay.test.js). External
// services are stubbed via require.cache before the router loads, so no
// Claude/Voyage/Resend call can fire.
//
// What matters here is that the sweep is COMPLETE and NARROW at the same time:
//
//   1. UnansweredQuestion is keyed on `entityDomain`, not `domain`, so the
//      original `{ domain }` sweep missed it entirely. Every row holds a
//      visitor's question verbatim plus their sessionToken and conversationId,
//      so a missed row is personal data left behind pointing at a conversation
//      that no longer resolves — and because the key is just a domain string,
//      re-creating the same domain (how a test entity gets re-made) re-attaches
//      every ghost row to the new entity's /unanswered page.
//   2. ArchivedChunk is swept by its own `domain` rather than by the snapshot
//      ids collected first, so a row whose snapshot row has already gone cannot
//      survive the delete.
//   3. A second entity seeded identically must come through completely
//      untouched — a widened filter here is somebody else's data loss.
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
const Chunk = require('../src/models/Chunk');
const ScrapedPage = require('../src/models/ScrapedPage');
const Conversation = require('../src/models/Conversation');
const ScrapeSnapshot = require('../src/models/ScrapeSnapshot');
const ArchivedChunk = require('../src/models/ArchivedChunk');
const Invite = require('../src/models/Invite');
const User = require('../src/models/User');
const UnansweredQuestion = require('../src/models/UnansweredQuestion');
const AuditLog = require('../src/models/AuditLog');

let mongod;
let server;
let baseUrl;

const DOOMED = 'doomed.example.com';
const KEPT = 'kept.example.com';

const SUPER = JSON.stringify({ superadmin: true, email: 'sa@steadfastcode.tech' });
const OWNER = JSON.stringify({ memberships: [{ entityDomain: DOOMED, role: 'owner' }] });

// Seeds one entity with a row in every collection the cascade is meant to
// sweep, including an archived chunk whose snapshot row is removed by hand so
// a snapshotId-keyed sweep would leave it behind.
async function seedEntity(domain) {
  const emb = [0.1, 0.2];
  await Entity.create({ domain, name: `Bakery at ${domain}` });

  await Chunk.insertMany([
    { domain, url: `https://${domain}/hours`, content: 'Open 9am daily.', embedding: emb, source: 'scraped' },
    { domain, url: `https://${domain}/menu`, content: 'Fresh bagels.', embedding: emb, source: 'scraped' },
  ]);

  await ScrapedPage.create({ domain, url: `https://${domain}/hours`, contentHash: 'hash-hours' });

  const conversation = await Conversation.create({
    domain,
    sessionToken: `leo_${domain}`,
    messages: [{ role: 'user', content: 'Are you open on Sundays?' }],
  });

  // Two snapshots. The second one's row is deleted by hand, leaving its
  // archived chunk orphaned — exactly the row a snapshotId sweep cannot see.
  const liveSnapshot = await ScrapeSnapshot.create({ domain, mode: 'full' });
  const orphanedSnapshot = await ScrapeSnapshot.create({ domain, mode: 'rescrape' });

  await ArchivedChunk.insertMany([
    { snapshotId: liveSnapshot._id, domain, url: `https://${domain}/hours`, content: 'Old hours.', embedding: emb },
    { snapshotId: orphanedSnapshot._id, domain, url: `https://${domain}/menu`, content: 'Old menu.', embedding: emb },
  ]);
  await ScrapeSnapshot.deleteOne({ _id: orphanedSnapshot._id });

  await Invite.create({
    token: `tok-${domain}`,
    domain,
    email: `invitee@${domain}`,
    role: 'agent',
    expiresAt: new Date(Date.now() + 86400000),
  });

  // Keyed on entityDomain, and holding the visitor's own words.
  await UnansweredQuestion.insertMany([
    { entityDomain: domain, question: `Do you deliver to ${domain}?`, sessionToken: `leo_${domain}`, conversationId: conversation._id },
    { entityDomain: domain, question: `Is there parking at ${domain}?`, sessionToken: `leo_${domain}`, conversationId: conversation._id },
  ]);

  await User.create({
    name: `Owner of ${domain}`,
    email: `owner@${domain}`,
    hashedPassword: 'x',
    memberships: [{ entityDomain: domain, roles: ['owner'] }],
  });
}

async function countsFor(domain) {
  const [chunks, pages, conversations, snapshots, archived, invites, unanswered, entities, memberships] =
    await Promise.all([
      Chunk.countDocuments({ domain }),
      ScrapedPage.countDocuments({ domain }),
      Conversation.countDocuments({ domain }),
      ScrapeSnapshot.countDocuments({ domain }),
      ArchivedChunk.countDocuments({ domain }),
      Invite.countDocuments({ domain }),
      UnansweredQuestion.countDocuments({ entityDomain: domain }),
      Entity.countDocuments({ domain }),
      User.countDocuments({ 'memberships.entityDomain': domain }),
    ]);
  return { chunks, pages, conversations, snapshots, archived, invites, unanswered, entities, memberships };
}

async function deleteEntity(domain, user) {
  const headers = {};
  if (user) headers['x-test-user'] = user;
  const res = await fetch(`${baseUrl}/api/dashboard/entities/${domain}`, { method: 'DELETE', headers });
  return { status: res.status, body: await res.json() };
}

async function getUnanswered(domain, user) {
  const res = await fetch(`${baseUrl}/api/dashboard/entities/${domain}/unanswered`, {
    headers: { 'x-test-user': user },
  });
  return { status: res.status, body: await res.json() };
}

// recordAudit is deliberately fire-and-forget, so the row can land after the
// response does. Poll rather than assume either ordering.
async function waitForAudit(action, domain, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await AuditLog.findOne({ action, domain }).lean();
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 25));
  }
}

let keptBefore;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const app = express();
  app.use(express.json());
  app.use('/api/dashboard', dashboardRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await seedEntity(DOOMED);
  await seedEntity(KEPT);
  keptBefore = await countsFor(KEPT);
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

// ---------------------------------------------------------------------------
// Gates first — a delete that the wrong person can run is worse than one that
// leaves rows behind.
// ---------------------------------------------------------------------------

test('a non-superadmin owner of the entity cannot delete it', async () => {
  const { status } = await deleteEntity(DOOMED, OWNER);
  assert.equal(status, 403);
  const after = await countsFor(DOOMED);
  assert.equal(after.entities, 1, 'the entity must still be there');
  assert.equal(after.unanswered, 2);
});

test('an unauthenticated request cannot delete it', async () => {
  const { status } = await deleteEntity(DOOMED, null);
  assert.equal(status, 401);
  assert.equal((await countsFor(DOOMED)).entities, 1);
});

test('deleting a domain with no entity is a 404', async () => {
  const { status } = await deleteEntity('nothing-here.example.com', SUPER);
  assert.equal(status, 404);
});

// ---------------------------------------------------------------------------
// The delete itself. One call, asserted from every angle below.
// ---------------------------------------------------------------------------

let deleteResponse;
let auditRow;

test('superadmin delete returns per-collection counts, including unanswered questions', async () => {
  // Sanity: everything the cascade must sweep is actually seeded.
  const before = await countsFor(DOOMED);
  assert.deepEqual(before, {
    chunks: 2, pages: 1, conversations: 1, snapshots: 1, archived: 2,
    invites: 1, unanswered: 2, entities: 1, memberships: 1,
  });

  deleteResponse = await deleteEntity(DOOMED, SUPER);
  assert.equal(deleteResponse.status, 200);
  assert.equal(deleteResponse.body.ok, true);

  const d = deleteResponse.body.deleted;
  assert.equal(d.chunks, 2);
  assert.equal(d.pages, 1);
  assert.equal(d.conversations, 1);
  assert.equal(d.snapshots, 1);
  // Both archived chunks, including the one whose snapshot row was removed.
  assert.equal(d.archivedChunks, 2, 'an orphaned archived chunk must still be counted');
  assert.equal(d.unansweredQuestions, 2, 'the visitor questions must be reported as deleted');
});

test('every collection is empty for the deleted domain', async () => {
  assert.deepEqual(await countsFor(DOOMED), {
    chunks: 0, pages: 0, conversations: 0, snapshots: 0, archived: 0,
    invites: 0, unanswered: 0, entities: 0, memberships: 0,
  });
});

test('no unanswered question survives anywhere under the deleted domain', async () => {
  // The assertion that goes red on unmodified main: the rows are keyed on
  // entityDomain, so a { domain } sweep leaves all of them in place.
  const leftovers = await UnansweredQuestion.find({ entityDomain: DOOMED }).lean();
  assert.deepEqual(leftovers, [], 'a verbatim visitor question was left in the database');
});

test('the AuditLog row records the unanswered count too', async () => {
  auditRow = await waitForAudit('entity.delete', DOOMED);
  assert.ok(auditRow, 'an entity.delete audit row must exist');
  assert.equal(auditRow.details.name, `Bakery at ${DOOMED}`);
  assert.equal(auditRow.details.chunks, 2);
  assert.equal(auditRow.details.pages, 1);
  assert.equal(auditRow.details.conversations, 1);
  assert.equal(auditRow.details.snapshots, 1);
  assert.equal(auditRow.details.archivedChunks, 2);
  assert.equal(auditRow.details.unansweredQuestions, 2);
});

test('the second entity is completely untouched', async () => {
  assert.deepEqual(await countsFor(KEPT), keptBefore);
  // Not just the counts — the rows themselves.
  const kept = await UnansweredQuestion.find({ entityDomain: KEPT }).sort({ question: 1 }).lean();
  assert.equal(kept.length, 2);
  assert.ok(kept.every((q) => q.question.includes(KEPT)));
  const keptUser = await User.findOne({ email: `owner@${KEPT}` }).lean();
  assert.equal(keptUser.memberships.length, 1);
  assert.equal(keptUser.memberships[0].entityDomain, KEPT);
});

test('re-creating the same domain yields an empty /unanswered page', async () => {
  // Nothing may re-attach itself to the new entity: the key is a domain
  // string and nothing else, so a surviving row would show up as the new
  // entity's own backlog.
  await Entity.create({ domain: DOOMED, name: 'Bakery, take two' });
  const { status, body } = await getUnanswered(DOOMED, SUPER);
  assert.equal(status, 200);
  assert.deepEqual(body, [], 'ghost questions re-attached to the re-created entity');
});
