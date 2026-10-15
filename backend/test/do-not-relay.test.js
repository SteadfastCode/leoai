// Per-entity do-not-relay list (LEO-047).
//
// Two halves:
//   1. Pure-function tests on services/doNotRelay — the matcher and the
//      write-path sanitiser.
//   2. The REAL dashboard router driven over HTTP against an in-memory MongoDB
//      (same harness shape as kb-search.test.js), proving doNotRelay actually
//      joined the PATCH allowlist and that the allowlist still holds for
//      everything else. External services are stubbed via require.cache before
//      the router loads, so no Claude/Voyage/Twilio/Resend call can ever fire.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const { sanitizeList, matchesDoNotRelay, MAX_ENTRIES, MAX_ENTRY_LENGTH } =
  require('../src/services/doNotRelay');

// ---------------------------------------------------------------------------
// matchesDoNotRelay
// ---------------------------------------------------------------------------

test('matcher is case-insensitive', () => {
  assert.equal(matchesDoNotRelay('What is the SALARY for a baker?', ['salary']), true);
  assert.equal(matchesDoNotRelay('what is the salary', ['SALARY']), true);
});

test('matcher is whitespace-insensitive', () => {
  assert.equal(matchesDoNotRelay('How do your   salary   bands work?', ['salary bands']), true);
  assert.equal(matchesDoNotRelay('salary\nbands', ['salary bands']), true);
  assert.equal(matchesDoNotRelay('salary bands', ['  salary   bands  ']), true);
});

test('matcher misses an unrelated question', () => {
  assert.equal(matchesDoNotRelay('What are your opening hours?', ['salary', 'competitor']), false);
});

test('matcher returns false for an empty or absent list', () => {
  assert.equal(matchesDoNotRelay('anything at all', []), false);
  assert.equal(matchesDoNotRelay('anything at all', undefined), false);
  assert.equal(matchesDoNotRelay('anything at all', null), false);
});

test('a blank list entry never matches everything', () => {
  // The one failure mode that would silently swallow every pending question.
  assert.equal(matchesDoNotRelay('What are your hours?', ['', '   ']), false);
});

test('matcher tolerates non-string input without throwing', () => {
  assert.equal(matchesDoNotRelay(undefined, ['salary']), false);
  assert.equal(matchesDoNotRelay('', ['salary']), false);
  assert.equal(matchesDoNotRelay('salary question', [null, 42, { a: 1 }, 'salary']), true);
});

test('matcher hits on any one phrase in the list', () => {
  const list = ['salary', 'competitor', 'legal advice'];
  assert.equal(matchesDoNotRelay('Can you give me legal advice on this?', list), true);
});

// ---------------------------------------------------------------------------
// sanitizeList
// ---------------------------------------------------------------------------

test('sanitizeList trims and collapses whitespace', () => {
  assert.deepEqual(sanitizeList(['  salary  questions ', 'a\n b']), ['salary questions', 'a b']);
});

test('sanitizeList dedupes case-insensitively, keeping the first spelling', () => {
  assert.deepEqual(sanitizeList(['Salary', 'salary', 'SALARY  ']), ['Salary']);
});

test('sanitizeList drops non-strings and empties', () => {
  assert.deepEqual(sanitizeList(['ok', null, undefined, 42, {}, [], '', '   ', 'two']), ['ok', 'two']);
});

test('sanitizeList caps entry length at MAX_ENTRY_LENGTH', () => {
  const [entry] = sanitizeList(['x'.repeat(MAX_ENTRY_LENGTH + 50)]);
  assert.equal(entry.length, MAX_ENTRY_LENGTH);
});

test('sanitizeList caps the list at MAX_ENTRIES', () => {
  const many = Array.from({ length: MAX_ENTRIES + 20 }, (_, i) => `topic ${i}`);
  const out = sanitizeList(many);
  assert.equal(out.length, MAX_ENTRIES);
  assert.equal(out[0], 'topic 0');
});

test('sanitizeList returns [] for non-array input', () => {
  assert.deepEqual(sanitizeList(undefined), []);
  assert.deepEqual(sanitizeList(null), []);
  assert.deepEqual(sanitizeList('salary'), []);
  assert.deepEqual(sanitizeList({ 0: 'salary' }), []);
});

test('sanitizeList output always matches via matchesDoNotRelay', () => {
  // Sanitiser and matcher share one normaliser — pin that they cannot drift.
  const [stored] = sanitizeList(['  Competitor   Comparisons ']);
  assert.equal(matchesDoNotRelay('how do you compare to COMPETITOR comparisons?', [stored]), true);
});

// ---------------------------------------------------------------------------
// Handoff alert safety net
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

const {
  buildQuestionBlock,
  buildHandoffSms,
  buildHandoffEmail,
  buildFollowUpSms,
  buildFollowUpEmail,
  describeWithheld,
  WITHHELD_FIELD,
} = require('../src/services/notifications');

test('buildQuestionBlock omits a matched question from the alert body', () => {
  const block = buildQuestionBlock(
    ['What are your hours?', 'What salary do you pay bakers?'],
    null,
    ['salary']
  );
  assert.ok(block.includes('What are your hours?'));
  assert.ok(!block.includes('salary do you pay'), 'matched question must not appear in the body');
  assert.ok(/1 question withheld/.test(block), 'owner is told something was withheld');
});

test('buildQuestionBlock with every question matched still renders a withheld line', () => {
  const block = buildQuestionBlock(['salary bands?', 'salary review?'], null, ['salary']);
  assert.ok(!block.includes('(no questions recorded)'),
    'suppressed must read differently from nothing-recorded');
  assert.ok(/2 questions withheld/.test(block));
});

test('buildQuestionBlock is unchanged when the list is empty', () => {
  const qs = ['What are your hours?', 'Do you deliver?'];
  assert.equal(buildQuestionBlock(qs, null, []), buildQuestionBlock(qs));
  assert.equal(buildQuestionBlock(qs, null, undefined), buildQuestionBlock(qs));
});

// ---------------------------------------------------------------------------
// The ASSEMBLED alert bodies (LEO-094)
// ---------------------------------------------------------------------------
//
// buildQuestionBlock filtering its own list is not enough to claim a question
// was withheld: chat.js passes the very same string as `reason`, and
// `lastMessage` is normally the visitor turn that produced it, so both printed
// it verbatim a line or two above the filtered block. "Not relayed" is only a
// true statement about the whole body, so that is what these assert.

const SALARY = 'What salary do you pay bakers?';
const alertParts = {
  entityName: 'Dosie Dough',
  reason: SALARY,
  lastMessage: SALARY,
  conversationLink: 'http://localhost:5173/#/conversations/abc123',
  shortSession: 'sess-12345',
  pendingQuestions: ['What are your hours?', SALARY],
  doNotRelay: ['salary'],
};

test('the assembled SMS body relays a matched question nowhere', () => {
  const sms = buildHandoffSms(alertParts);
  assert.ok(!/salary/i.test(sms), `matched text leaked into the SMS:\n${sms}`);
  // The alert still goes out — the owner has to know someone is waiting.
  assert.ok(sms.includes('• What are your hours?'), 'an unmatched question is still relayed');
  assert.ok(sms.includes(alertParts.conversationLink));
  assert.ok(sms.includes(WITHHELD_FIELD), 'withheld fields are marked, not silently blanked');
  assert.ok(/1 question withheld/.test(sms));
});

test('the assembled email body relays a matched question nowhere', () => {
  const { subject, text } = buildHandoffEmail(alertParts);
  assert.ok(!/salary/i.test(text), `matched text leaked into the email:\n${text}`);
  assert.ok(!/salary/i.test(subject));
  assert.ok(text.includes('• What are your hours?'));
  assert.ok(text.includes(alertParts.conversationLink));
  assert.ok(text.includes(WITHHELD_FIELD));
});

test('a clean reason survives while a matched last message is withheld', () => {
  const sms = buildHandoffSms({ ...alertParts, reason: 'Do you deliver?', pendingQuestions: ['Do you deliver?'] });
  assert.ok(sms.includes('Visitor needs help: "Do you deliver?"'), 'a surviving field keeps its quotes');
  assert.ok(!/salary/i.test(sms));
  assert.ok(sms.includes(`Last message: ${WITHHELD_FIELD}`), 'the marker is never quoted — nobody said it');
});

test('the follow-up reminder applies the list too', () => {
  const parts = {
    entityName: 'Dosie Dough',
    conversationLink: alertParts.conversationLink,
    shortSession: 'sess-12345',
    pendingQuestions: alertParts.pendingQuestions,
    doNotRelay: ['salary'],
  };
  const sms = buildFollowUpSms(parts);
  const { text } = buildFollowUpEmail(parts);
  assert.ok(!/salary/i.test(sms), `matched text leaked into the reminder SMS:\n${sms}`);
  assert.ok(!/salary/i.test(text), `matched text leaked into the reminder email:\n${text}`);
  assert.ok(sms.includes('• What are your hours?'));
  assert.ok(/1 question withheld/.test(text));
});

test('an empty list leaves the assembled bodies untouched', () => {
  const clean = {
    ...alertParts,
    reason: 'Do you deliver?',
    lastMessage: 'Do you deliver a starter to Canada?',
    pendingQuestions: ['Do you deliver?'],
  };
  assert.equal(buildHandoffSms({ ...clean, doNotRelay: [] }), buildHandoffSms({ ...clean, doNotRelay: undefined }));
  assert.equal(
    buildHandoffEmail({ ...clean, doNotRelay: [] }).text,
    buildHandoffEmail({ ...clean, doNotRelay: undefined }).text
  );
  // A configured list that matches nothing must also leave no trace.
  assert.ok(!buildHandoffSms({ ...clean, doNotRelay: ['salary'] }).includes(WITHHELD_FIELD));
});

test('describeWithheld names the fields and a count, never the text', () => {
  assert.equal(describeWithheld(alertParts), 'reason, lastMessage, 1 question');
  assert.equal(describeWithheld({ ...alertParts, doNotRelay: [] }), null, 'no list, nothing withheld');
  assert.equal(
    describeWithheld({ reason: 'hours?', lastMessage: 'hours?', pendingQuestions: ['hours?'], doNotRelay: ['salary'] }),
    null,
    'a list that matches nothing reports nothing'
  );
});

// ---------------------------------------------------------------------------
// System prompt clause — the actual mechanism (the alert filter is only a net)
// ---------------------------------------------------------------------------

// claude.js constructs the Anthropic client at require time, which throws
// without a key. No request is ever made — buildSystemPrompt is pure.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-used';
const { buildSystemPrompt } = require('../src/services/claude');

test('a non-empty list adds one clause naming the topics to the handoff instruction', () => {
  const prompt = buildSystemPrompt({ name: 'A Bakery', doNotRelay: ['  Salary  questions ', 'competitors'] }, null);
  assert.ok(prompt.includes('NEVER to forward'), 'clause is present');
  assert.ok(prompt.includes('"Salary questions"'), 'topic is normalised, then named verbatim');
  assert.ok(prompt.includes('"competitors"'));
  assert.ok(prompt.includes('do NOT append [HANDOFF_REQUESTED]'),
    'Leo is told not to raise a handoff for these');
  assert.ok(!prompt.includes('[HANDOFF_MODE_INSTRUCTION]'),
    'the placeholder is substituted, not left literal');
});

test('an empty or absent list leaves the handoff instruction untouched', () => {
  const base = buildSystemPrompt({ name: 'A Bakery' }, null);
  assert.ok(!base.includes('NEVER to forward'));
  assert.ok(!buildSystemPrompt({ name: 'A Bakery', doNotRelay: [] }, null).includes('NEVER to forward'));
  // A junk value must not crash prompt construction — it is read on every chat.
  assert.ok(!buildSystemPrompt({ name: 'A Bakery', doNotRelay: 'salary' }, null).includes('NEVER to forward'));
});

// ---------------------------------------------------------------------------
// PATCH /entities/:domain allowlist, over the real router
// ---------------------------------------------------------------------------

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

const dashboardRouter = require('../src/routes/dashboard');
const Entity = require('../src/models/Entity');

let mongod;
let server;
let baseUrl;

const DOMAIN = 'a.example.com';
const OWNER = JSON.stringify({
  memberships: [{ entityDomain: DOMAIN, role: 'owner' }],
});

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

test('an owner can set doNotRelay, and it is sanitised on write', async () => {
  const { status, body } = await patchEntity({
    doNotRelay: ['  Salary   questions ', 'salary questions', 'Competitors', 7, ''],
  });
  assert.equal(status, 200);
  assert.deepEqual(body.doNotRelay, ['Salary questions', 'Competitors']);

  const stored = await Entity.findOne({ domain: DOMAIN });
  assert.deepEqual([...stored.doNotRelay], ['Salary questions', 'Competitors']);
});

test('an unlisted field is still ignored by the PATCH allowlist', async () => {
  const { status, body } = await patchEntity({
    doNotRelay: ['Competitors'],
    plan: 'lifetime',          // not on the allowlist
    messageCount: 999999,      // not on the allowlist
    ragThreshold: 0.51,        // superadmin-only
  });
  assert.equal(status, 200);
  assert.equal(body.plan, 'free', 'plan must not be settable by an owner');
  assert.equal(body.messageCount, 0);
  assert.equal(body.ragThreshold, 0.75);
  assert.deepEqual(body.doNotRelay, ['Competitors']);
});

test('doNotRelay can be cleared back to an empty list', async () => {
  const { status, body } = await patchEntity({ doNotRelay: [] });
  assert.equal(status, 200);
  assert.deepEqual(body.doNotRelay, []);
});

test('a non-array doNotRelay is coerced to [] rather than rejected or stored raw', async () => {
  await patchEntity({ doNotRelay: ['Competitors'] });
  const { status, body } = await patchEntity({ doNotRelay: 'salary' });
  assert.equal(status, 200);
  assert.deepEqual(body.doNotRelay, []);
});

test('a member of another entity cannot patch this one', async () => {
  const other = JSON.stringify({ memberships: [{ entityDomain: 'b.example.com' }] });
  const { status } = await patchEntity({ doNotRelay: ['anything'] }, other);
  assert.equal(status, 403);
});
