// Chat-flow regression harness (LEO-001).
//
// Drives the REAL /chat router (backend/src/routes/chat.js) over HTTP against an
// in-memory MongoDB. External services (Claude, Voyage/RAG, Twilio/Resend
// notifications) are stubbed by pre-populating require.cache BEFORE the router
// is required — the real service modules never load, so no network call, SMS,
// or email can ever fire from this suite.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

// ---------------------------------------------------------------------------
// Mutable stub state — tests reassign these between requests.
// ---------------------------------------------------------------------------
const stubState = {
  // What the stubbed Claude chat() returns as Leo's raw reply text.
  replyText: 'Hello! How can I help?',
  // What the stubbed RAG layer returns.
  ragResult: { context: 'Some relevant context.', ownerReplyContext: '', sources: [], topScore: 0.9 },
  // Call records for notification stubs.
  handoffCalls: [],
  quotaWarningCalls: [],
  quotaExceededCalls: [],
  // Captures the conversation argument chat() was invoked with (history-load proof).
  lastChatArgs: null,
};

function stubModule(resolvedPath, exportsObject) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsObject,
  };
}

const srcDir = path.join(__dirname, '..', 'src');

stubModule(require.resolve(path.join(srcDir, 'services', 'claude.js')), {
  chat: async (args) => {
    // Snapshot the history length at call time — the route mutates this same
    // conversation object after chat() returns, so a live reference would lie.
    stubState.lastChatArgs = {
      hadConversation: !!args.conversation,
      historyLengthAtCallTime: args.conversation ? args.conversation.messages.length : null,
    };
    return {
      text: stubState.replyText,
      model: 'stub-model',
      classifierRoute: 'simple',
      classifierReason: 'stubbed',
    };
  },
  classifyQuery: async () => ({ route: 'simple', reason: 'stubbed' }),
  summarizeTopic: async () => 'stubbed topic',
});

stubModule(require.resolve(path.join(srcDir, 'services', 'rag.js')), {
  retrieveContext: async () => ({ ...stubState.ragResult }),
});

stubModule(require.resolve(path.join(srcDir, 'services', 'notifications.js')), {
  sendHandoffNotification: async (args) => { stubState.handoffCalls.push(args); },
  sendQuotaWarning: async (args) => { stubState.quotaWarningCalls.push(args); },
  sendQuotaExceededNotification: async (args) => { stubState.quotaExceededCalls.push(args); },
});

stubModule(require.resolve(path.join(srcDir, 'services', 'logger.js')), {
  error: () => {},
  warn: () => {},
  info: () => {},
});

// ---------------------------------------------------------------------------
// Boot: in-memory Mongo + express app mounting the real router.
// ---------------------------------------------------------------------------
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

const chatRouter = require('../src/routes/chat');
const Entity = require('../src/models/Entity');
const Conversation = require('../src/models/Conversation');

let mongod;
let server;
let baseUrl;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const app = express();
  app.use(express.json());
  // The router emits socket events via req.app.get('io') — a no-op stand-in.
  app.set('io', { to: () => ({ emit: () => {} }) });
  app.use('/chat', chatRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  // Let fire-and-forget promises (lastTopic updates, entity saves) settle
  // before tearing the connection down under them.
  await new Promise((r) => setTimeout(r, 250));
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

function resetStubs() {
  stubState.replyText = 'Hello! How can I help?';
  stubState.ragResult = { context: 'Some relevant context.', ownerReplyContext: '', sources: [], topScore: 0.9 };
  stubState.handoffCalls = [];
  stubState.quotaWarningCalls = [];
  stubState.quotaExceededCalls = [];
  stubState.lastChatArgs = null;
}

async function postChat(body) {
  const res = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// Poll until the persisted entity satisfies a predicate — the quota-exceeded
// flag is saved fire-and-forget, so the HTTP response can beat the write.
async function waitForEntity(domain, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const doc = await Entity.findOne({ domain });
    if (predicate(doc)) return doc;
    if (Date.now() > deadline) throw new Error('waitForEntity: condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// 1. Free-tier quota at 99 / 100 / 101 messages
// ---------------------------------------------------------------------------
test('free-tier quota: message 100 succeeds, 101 is rejected with 402, owner notified once', async () => {
  resetStubs();
  const domain = 'quota-test.example.com';
  await Entity.create({ domain, name: 'Quota Test', plan: 'free', messageCountThisPeriod: 99 });

  // Message #100 (counter 99 -> 100): allowed.
  const r100 = await postChat({ domain, sessionToken: 'quota-session', message: 'hello at 99' });
  assert.equal(r100.status, 200);
  assert.equal(r100.body.usage.messageCountThisPeriod, 100);
  assert.equal(r100.body.usage.limitThisPeriod, 100);

  // Wait for the awaited entity.save() from message #100 to be visible.
  await waitForEntity(domain, (e) => e.messageCountThisPeriod === 100);

  // Message #101: over the limit — 402, quota_exceeded, owner notified.
  const r101 = await postChat({ domain, sessionToken: 'quota-session', message: 'hello at 100' });
  assert.equal(r101.status, 402);
  assert.equal(r101.body.error, 'quota_exceeded');
  assert.equal(r101.body.messageCountThisPeriod, 100);

  // The exceeded notification is guarded by quotaExceededNotified (saved
  // fire-and-forget) — wait for the flag before the next request.
  await waitForEntity(domain, (e) => e.quotaExceededNotified === true);
  assert.equal(stubState.quotaExceededCalls.length, 1);

  // Message #102: still 402, and the owner is NOT notified a second time.
  const r102 = await postChat({ domain, sessionToken: 'quota-session', message: 'hello again' });
  assert.equal(r102.status, 402);
  assert.equal(stubState.quotaExceededCalls.length, 1);

  // The counter never moved past the limit.
  const finalEntity = await Entity.findOne({ domain });
  assert.equal(finalEntity.messageCountThisPeriod, 100);
});

// ---------------------------------------------------------------------------
// 2. First handoff fires exactly once (the atomic test-and-set)
// ---------------------------------------------------------------------------
test('handoff notification fires exactly once per conversation', async () => {
  resetStubs();
  const domain = 'handoff-test.example.com';
  await Entity.create({ domain, name: 'Handoff Test', plan: 'infinity', ownerEmail: 'stub-owner@example.invalid' });

  stubState.replyText = "I'll check with the owner. [HANDOFF_REQUESTED: What are the gluten-free options?]";
  const r1 = await postChat({ domain, sessionToken: 'handoff-session', message: 'Do you have gluten-free bread?' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.handoffTriggered, true);
  assert.equal(stubState.handoffCalls.length, 1, 'first handoff must notify the owner');

  // A second, different handoff in the SAME conversation must not re-notify.
  stubState.replyText = "I'll pass that along too. [HANDOFF_REQUESTED: Can you cater a wedding next June?]";
  const r2 = await postChat({ domain, sessionToken: 'handoff-session', message: 'Also, do you cater weddings?' });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.handoffTriggered, true);
  assert.equal(stubState.handoffCalls.length, 1, 'second handoff in same conversation must NOT re-notify');

  // Both distinct questions accumulate on the conversation.
  const convo = await Conversation.findOne({ sessionToken: 'handoff-session', domain });
  assert.equal(convo.handoffPending, true);
  assert.equal(convo.pendingQuestions.length, 2);
});

// ---------------------------------------------------------------------------
// 3. [HANDOFF_REQUESTED] / [OPTIONS:] are stripped from the visitor-facing reply
// ---------------------------------------------------------------------------
test('handoff and options markers are stripped; options are parsed into buttons', async () => {
  resetStubs();
  const domain = 'strip-test.example.com';
  await Entity.create({ domain, name: 'Strip Test', plan: 'infinity' });

  stubState.replyText = 'Let me ask the owner about that. [HANDOFF_REQUESTED: Do you ship internationally?]';
  const r1 = await postChat({ domain, sessionToken: 'strip-session', message: 'Do you ship to Canada?' });
  assert.equal(r1.status, 200);
  assert.ok(!r1.body.reply.includes('[HANDOFF_REQUESTED'), 'handoff marker must be stripped');
  assert.equal(r1.body.reply, 'Let me ask the owner about that.');
  assert.equal(r1.body.handoffTriggered, true);

  stubState.replyText = 'Would you like to hear about our breads? [OPTIONS: Yes | No]';
  const r2 = await postChat({ domain, sessionToken: 'strip-session', message: 'What do you sell?' });
  assert.equal(r2.status, 200);
  assert.ok(!r2.body.reply.includes('[OPTIONS'), 'options marker must be stripped');
  assert.equal(r2.body.reply, 'Would you like to hear about our breads?');
  assert.deepEqual(r2.body.options, ['Yes', 'No']);
});

// ---------------------------------------------------------------------------
// 4. Returning visitor: existing history is loaded, not restarted
// ---------------------------------------------------------------------------
test('returning visitor: history endpoint returns prior messages and /chat appends to them', async () => {
  resetStubs();
  const domain = 'history-test.example.com';
  const sessionToken = 'returning-session';
  await Entity.create({ domain, name: 'History Test', plan: 'infinity' });
  await Conversation.create({
    sessionToken,
    domain,
    lastTopic: 'sourdough loaves',
    messages: [
      { role: 'user', content: 'Do you make sourdough?' },
      { role: 'assistant', content: 'We do! Fresh every morning.' },
    ],
  });

  // History endpoint returns the stored messages and topic.
  const hres = await fetch(`${baseUrl}/chat/history?domain=${domain}&sessionToken=${sessionToken}`);
  assert.equal(hres.status, 200);
  const history = await hres.json();
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[0].content, 'Do you make sourdough?');
  assert.equal(history.lastTopic, 'sourdough loaves');

  // A new /chat turn loads the SAME conversation (passes it to the model) and appends.
  const r = await postChat({ domain, sessionToken, message: 'What time do you open?' });
  assert.equal(r.status, 200);
  assert.ok(stubState.lastChatArgs.hadConversation, 'chat() must receive the existing conversation');
  assert.equal(stubState.lastChatArgs.historyLengthAtCallTime, 2, 'prior history must be loaded before the new turn');

  const convo = await Conversation.findOne({ sessionToken, domain });
  assert.equal(convo.messages.length, 4, 'user + assistant turns appended to existing history');
  assert.equal(convo.messages[2].content, 'What time do you open?');
});
