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

const crypto = require('node:crypto');
const chatRouter = require('../src/routes/chat');
const Entity = require('../src/models/Entity');
const Conversation = require('../src/models/Conversation');
const ApiKey = require('../src/models/ApiKey');

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

async function postChat(body, extraHeaders = {}) {
  const res = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
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

// ---------------------------------------------------------------------------
// 5. Test-mode (LEO-025): a valid X-API-Key suppresses quota + notifications,
//    returns isTest:true, and marks the conversation. This is the end-to-end
//    contract the MCP send_test_message tool depends on — the gate helper is
//    unit-tested separately (test-mode-gate.test.js), but nothing asserted the
//    live /chat behaviour, which is exactly where the MCP client silently ran
//    as real traffic by not sending the key.
// ---------------------------------------------------------------------------
test('test-mode: keyed /chat returns isTest, skips the counter, and fires no owner notification', async () => {
  resetStubs();
  const domain = 'testmode.example.com';
  // Free tier + owner contact so a real message WOULD count and WOULD notify —
  // proving the suppression is the key's doing, not an absent trigger.
  await Entity.create({ domain, name: 'Test Mode', plan: 'free', messageCountThisPeriod: 5, ownerEmail: 'stub-owner@example.invalid' });

  const rawKey = 'leoai_testmode_' + crypto.randomBytes(8).toString('hex');
  await ApiKey.create({
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    label: 'chat-flow-test',
    scope: 'mcp',
  });

  // A reply that WOULD fire a handoff notification for a normal visitor.
  stubState.replyText = "I'll check with the team. [HANDOFF_REQUESTED: Do you deliver on Sundays?]";
  const r = await postChat(
    { domain, sessionToken: 'testmode-session', message: 'Do you deliver Sundays?' },
    { 'X-API-Key': rawKey }
  );

  assert.equal(r.status, 200);
  assert.equal(r.body.isTest, true, 'a valid key must put the response in test-mode');
  assert.equal(r.body.handoffTriggered, true, 'the reply still triggers a handoff...');
  assert.equal(stubState.handoffCalls.length, 0, '...but test-mode fires NO owner notification');
  assert.equal(r.body.usage.messageCountThisPeriod, 5, 'test-mode does not increment the live counter in the response');

  const entity = await Entity.findOne({ domain });
  assert.equal(entity.messageCountThisPeriod, 5, 'the persisted counter is unchanged');
  const convo = await Conversation.findOne({ sessionToken: 'testmode-session', domain });
  assert.equal(convo.isTest, true, 'the conversation is flagged isTest');

  // Control: the SAME request WITHOUT the key is real traffic — counter moves,
  // owner is notified. This is what the MCP tool was doing before the fix.
  const rReal = await postChat({ domain, sessionToken: 'real-session', message: 'Do you deliver Sundays?' });
  assert.equal(rReal.body.isTest, false, 'no key = real traffic');
  assert.equal(stubState.handoffCalls.length, 1, 'real traffic DOES notify the owner');
  await waitForEntity(domain, (e) => e.messageCountThisPeriod === 6);
});

// ---------------------------------------------------------------------------
// 6. Rate limit (LEO-034): a rapid over-limit session gets 429 with a widget-
//    renderable body; a keyed (test-mode) session is never throttled. The
//    limiter itself is unit-tested in rate-limit.test.js — this asserts the
//    live wiring in chat.js, including the bypass the nightly smoke relies on.
// ---------------------------------------------------------------------------
test('rate limit: rapid over-limit /chat returns 429, keyed requests bypass', async () => {
  resetStubs();
  const domain = 'ratelimit.example.com';
  await Entity.create({ domain, name: 'Rate Limit', plan: 'infinity' });

  // Distinct forwarded IP so this hammering session consumes its own IP
  // budget, not the shared 127.0.0.1 budget every other test runs on.
  const xff = { 'X-Forwarded-For': '198.51.100.34' };

  // Session cap is 20/min — the 21st rapid message must be throttled.
  let last;
  for (let i = 0; i < 21; i++) {
    last = await postChat({ domain, sessionToken: 'hammer-session', message: `msg ${i}` }, xff);
  }
  assert.equal(last.status, 429, '21st rapid message in one session must be 429');
  assert.equal(last.body.error, 'rate_limited');
  assert.ok(last.body.message, 'the 429 body carries a widget-renderable message');
  assert.ok(last.body.retryAfterSeconds >= 1, 'the 429 body says when to retry');

  // A fresh session from the same IP still gets through (session cap, not IP).
  const other = await postChat({ domain, sessionToken: 'other-session', message: 'hello' }, xff);
  assert.equal(other.status, 200, 'a different session on the same IP is not throttled');

  // Keyed (test-mode) requests bypass all limits — the smoke must never throttle.
  const rawKey = 'leoai_ratelimit_' + crypto.randomBytes(8).toString('hex');
  await ApiKey.create({
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    label: 'rate-limit-test',
    scope: 'mcp',
  });
  for (let i = 0; i < 25; i++) {
    const keyed = await postChat(
      { domain, sessionToken: 'hammer-session', message: `keyed ${i}` },
      { ...xff, 'X-API-Key': rawKey }
    );
    assert.equal(keyed.status, 200, 'keyed requests are never rate limited');
  }
});
