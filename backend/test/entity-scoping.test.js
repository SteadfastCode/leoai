// Entity scoping of by-id dashboard routes (LEO-107).
//
// The `router.param('domain')` floor added by LEO-P0-3 proves the caller holds a
// membership for the domain IN THE PATH. It cannot prove that the object they name
// in the next path segment belongs to that domain, and three handlers never checked:
//
//   GET    /entities/:domain/conversations/:id          Conversation.findById(id)
//   POST   /entities/:domain/conversations/:id/reply    Conversation.findById(id)
//   DELETE /entities/:domain/invites/:inviteId          Invite.findByIdAndDelete(id)
//
// So a member of entity A, naming their OWN domain in the path and entity B's object
// id in the next segment, got:
//
//   (1) B's whole conversation document — every visitor message, pendingQuestions,
//       handoffPending, and the sessionToken, which GET /chat/history accepts as a
//       credential.
//   (2) an `owner_reply` pushed into B's conversation with seenByVisitor: false, so
//       B's visitor is greeted with A's text on their next widget open — while the
//       unanswered-question resolution and the owner_reply chunk landed on A. One
//       request, two entities, each holding half the result.
//   (3) any other entity's pending invite cancelled.
//
// The correct pattern was already in the same file three times (resolve-handoff at
// `Conversation.findOne({ _id, domain })`, and both unanswered routes at
// `UnansweredQuestion.findOne({ _id, entityDomain })`). All three now use it.
//
// Every "foreign id" test below is red against unmodified main: the GET answers 200
// with the foreign transcript, the reply answers 200 and mutates two entities, and
// the invite DELETE answers { ok: true } having deleted a row it did not own.
//
// The REAL middleware/auth is used — real User documents, real signed tokens, real
// permission gate — because the member doing this legitimately holds
// CONVERSATIONS_REPLY and USERS_MANAGE on their own entity; that is the whole point.
// Only outbound email and the embedding/RAG services are stubbed via require.cache,
// so no Resend, Voyage or Claude call can fire.
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

stubModule(require.resolve(path.join(srcDir, 'services', 'email.js')), {
  sendEmailRaw: async () => { throw new Error('sendEmailRaw must not be called in this suite'); },
});

// A reply that reached the knowledge base would embed. Nothing in this suite should,
// so an accidental call is a loud 500 rather than a silent network attempt.
stubModule(require.resolve(path.join(srcDir, 'services', 'embeddings.js')), {
  embedTexts: async () => { throw new Error('embedTexts must not be called in this suite'); },
  embedQuery: async () => { throw new Error('embedQuery must not be called in this suite'); },
});

stubModule(require.resolve(path.join(srcDir, 'services', 'rag.js')), {
  retrieveContext: async () => { throw new Error('retrieveContext must not be called in this suite'); },
});

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

const dashboardRouter = require('../src/routes/dashboard');
const Entity = require('../src/models/Entity');
const Conversation = require('../src/models/Conversation');
const Chunk = require('../src/models/Chunk');
const Invite = require('../src/models/Invite');
const User = require('../src/models/User');
const UnansweredQuestion = require('../src/models/UnansweredQuestion');
const { signAccessToken } = require('../src/middleware/auth');

const MINE = 'mine.example';
const THEIRS = 'theirs.example';
const HASHED = 'x'.repeat(60);

let mongod, server, baseUrl;
let member, superadmin;
// Emitted owner_reply pushes. The real route hands the reply to socket.io keyed by
// sessionToken, so a leak here is the same leak in a different clothing.
const emitted = [];

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  await Entity.create({ domain: MINE, name: 'My Bakery' });
  await Entity.create({ domain: THEIRS, name: 'Somebody Else' });

  // An ordinary customer: owner of ONE entity, so CONVERSATIONS_REPLY and
  // USERS_MANAGE on that domain and no membership at all for the other.
  member = await User.create({
    name: 'Ordinary Owner', email: 'owner@mine.example', hashedPassword: HASHED,
    memberships: [{ entityDomain: MINE, roles: ['owner'], permissions: [] }],
  });
  superadmin = await User.create({
    name: 'Daniel', email: 'daniel@steadfastcode.tech', hashedPassword: HASHED,
    memberships: [{ entityDomain: 'steadfastcode.tech', roles: ['superadmin'], permissions: [] }],
  });

  const app = express();
  app.use(express.json());
  app.set('io', { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) });
  app.use('/api/dashboard', dashboardRouter);

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function req(method, path, body, user) {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers.Authorization = `Bearer ${signAccessToken(user)}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let seq = 0;

// A conversation with everything the GET route hands back: a transcript, an open
// handoff, pending questions, and the sessionToken that /chat/history treats as a
// credential.
function makeConversation(domain) {
  seq += 1;
  return Conversation.create({
    domain,
    sessionToken: `tok-${domain}-${seq}`,
    handoffPending: true,
    pendingQuestions: [{ text: 'Do you deliver on Sundays?' }],
    messages: [
      { role: 'user', content: `a private question for ${domain}` },
      { role: 'assistant', content: 'Let me get someone to help!' },
    ],
  });
}

function makeInvite(domain) {
  seq += 1;
  return Invite.create({
    token: `invite-token-${seq}`,
    domain,
    email: `pending-${seq}@example.com`,
    role: 'agent',
    expiresAt: new Date(Date.now() + 36e5),
  });
}

// Byte-identical is asserted literally: the whole stored document, including
// updatedAt, which a stray conversation.save() would move even if it appended nothing.
const snapshot = (model, id) => model.findById(id).lean().then((d) => JSON.stringify(d));

// ---------------------------------------------------------------------------
// (1) GET a single conversation
// ---------------------------------------------------------------------------

test('GET conversation: a foreign id under my own domain is 404 and reads nothing', async () => {
  const theirs = await makeConversation(THEIRS);
  const before = await snapshot(Conversation, theirs._id);

  const res = await req('GET', `/api/dashboard/entities/${MINE}/conversations/${theirs._id}`, undefined, member);

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Not found', 'the handler keeps its existing message');
  // Nothing of theirs may come back, least of all the session token.
  assert.equal(res.body.sessionToken, undefined);
  assert.equal(res.body.messages, undefined);
  assert.equal(await snapshot(Conversation, theirs._id), before, 'and their document is untouched');
});

test('GET conversation: my own conversation behaves exactly as today', async () => {
  const mine = await makeConversation(MINE);

  const res = await req('GET', `/api/dashboard/entities/${MINE}/conversations/${mine._id}`, undefined, member);

  assert.equal(res.status, 200);
  assert.equal(res.body._id, String(mine._id));
  assert.equal(res.body.domain, MINE);
  assert.equal(res.body.messages.length, 2);
  assert.equal(res.body.handoffPending, true, 'handoffPending is still returned');
  assert.equal(res.body.pendingQuestions.length, 1, 'pendingQuestions is still returned');
  assert.equal(res.body.sessionToken, mine.sessionToken, 'no response field was removed');
});

test('GET conversation: a superadmin is unaffected', async () => {
  const theirs = await makeConversation(THEIRS);

  // Reaching an object through its OWN domain is what a superadmin does, and it
  // still works. The scoping is on the object, not on the caller.
  const ok = await req('GET', `/api/dashboard/entities/${THEIRS}/conversations/${theirs._id}`, undefined, superadmin);
  assert.equal(ok.status, 200);
  assert.equal(ok.body._id, String(theirs._id));

  // And a mismatched pair is a 404 even for a superadmin — the id simply is not in
  // that domain. isSuperAdmin bypasses the membership floor, not reality.
  const mismatched = await req('GET', `/api/dashboard/entities/${MINE}/conversations/${theirs._id}`, undefined, superadmin);
  assert.equal(mismatched.status, 404);
});

test('GET conversation: a non-member is still refused by the membership floor', async () => {
  const theirs = await makeConversation(THEIRS);
  const res = await req('GET', `/api/dashboard/entities/${THEIRS}/conversations/${theirs._id}`, undefined, member);
  assert.equal(res.status, 403, 'the LEO-P0-3 floor still answers first for a domain I am not in');
});

// ---------------------------------------------------------------------------
// (2) POST an owner reply
// ---------------------------------------------------------------------------

test('POST reply: a foreign id under my own domain is 404 and writes to neither entity', async () => {
  const theirs = await makeConversation(THEIRS);
  const before = await snapshot(Conversation, theirs._id);
  emitted.length = 0;

  // Seed the half of the write that used to land on MY entity: an open unanswered
  // question whose text the reply claims to answer.
  const question = 'Do you deliver on Sundays?';
  const mineUq = await UnansweredQuestion.create({ entityDomain: MINE, question });

  const res = await req(
    'POST',
    `/api/dashboard/entities/${MINE}/conversations/${theirs._id}/reply`,
    { replyText: 'Yes, every Sunday!', answeredQuestions: [question], addToKb: true },
    member
  );

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Conversation not found', 'the handler keeps its existing message');

  // Their half: no owner_reply appended, nothing delivered to their visitor.
  const after = await Conversation.findById(theirs._id).lean();
  assert.equal(after.messages.length, 2, 'their transcript gained nothing');
  assert.equal(await snapshot(Conversation, theirs._id), before, 'their document is byte-identical');
  assert.equal(emitted.length, 0, 'and nothing was pushed to their session');

  // My half: the request failed whole, so none of the side effects fired here either.
  assert.equal((await UnansweredQuestion.findById(mineUq._id)).resolvedByReply, false,
    'my unanswered question was not resolved by a reply that never landed');
  assert.equal(await Chunk.countDocuments({ domain: MINE, source: 'owner_reply' }), 0,
    'and no owner_reply chunk was embedded into my knowledge base');
});

test('POST reply: my own conversation behaves exactly as today', async () => {
  const mine = await makeConversation(MINE);
  emitted.length = 0;

  // No answeredQuestions, so the embedding path stays untouched (embedTexts is
  // stubbed to throw) — the reply append itself is what is under test.
  const res = await req(
    'POST',
    `/api/dashboard/entities/${MINE}/conversations/${mine._id}/reply`,
    { replyText: 'Yes, every Sunday!' },
    member
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.addedToKb, false);
  const last = res.body.conversation.messages.at(-1);
  assert.equal(last.role, 'owner_reply');
  assert.equal(last.content, 'Yes, every Sunday!');
  assert.equal(last.seenByVisitor, false, 'still unseen, so the visitor is greeted with it');

  const stored = await Conversation.findById(mine._id).lean();
  assert.equal(stored.messages.length, 3);
  assert.equal(stored.messages.at(-1).role, 'owner_reply');
  assert.equal(emitted.length, 1, 'and it is still pushed to the live session');
  assert.equal(emitted[0].room, mine.sessionToken);
  assert.equal(emitted[0].event, 'owner_reply');
});

test('POST reply: a superadmin is unaffected', async () => {
  const theirs = await makeConversation(THEIRS);
  emitted.length = 0;

  const ok = await req(
    'POST',
    `/api/dashboard/entities/${THEIRS}/conversations/${theirs._id}/reply`,
    { replyText: 'On my way.' },
    superadmin
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.conversation.messages.at(-1).role, 'owner_reply');
  assert.equal(emitted.length, 1);
});

// ---------------------------------------------------------------------------
// (3) DELETE a pending invite
// ---------------------------------------------------------------------------

test('DELETE invite: a foreign id under my own domain is 404 and leaves the row', async () => {
  const theirs = await makeInvite(THEIRS);

  const res = await req('DELETE', `/api/dashboard/entities/${MINE}/invites/${theirs._id}`, undefined, member);

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Invite not found');
  assert.notEqual(res.body.ok, true, 'and it does not report success');
  const still = await Invite.findById(theirs._id);
  assert.ok(still, 'their pending invite is still present');
  assert.equal(still.domain, THEIRS);
});

test('DELETE invite: my own invite is still cancelled and still answers { ok: true }', async () => {
  const mine = await makeInvite(MINE);

  const res = await req('DELETE', `/api/dashboard/entities/${MINE}/invites/${mine._id}`, undefined, member);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(await Invite.findById(mine._id), null, 'the row is gone');
});

test('DELETE invite: an id that exists nowhere is a 404, not a cheerful ok', async () => {
  // Previously findByIdAndDelete returned null here and the route answered
  // { ok: true } regardless, so "cancelled" and "never existed" were the same reply.
  const gone = new mongoose.Types.ObjectId();
  const res = await req('DELETE', `/api/dashboard/entities/${MINE}/invites/${gone}`, undefined, member);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Invite not found');
});

test('DELETE invite: a superadmin is unaffected', async () => {
  const theirs = await makeInvite(THEIRS);
  const res = await req('DELETE', `/api/dashboard/entities/${THEIRS}/invites/${theirs._id}`, undefined, superadmin);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(await Invite.findById(theirs._id), null);
});
