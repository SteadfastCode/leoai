// Alpha usage report (LEO-050).
//
// Two halves:
//   1. shapeUsageRows against fixtures — pure, no DB (the analytics.test.js shape).
//   2. the REAL admin router over HTTP against an in-memory MongoDB with seeded
//      conversations across two entities and three days (the kb-search.test.js
//      harness shape): auth stubbed to inject a user from a test header,
//      embeddings/scraper stubbed so requiring the router stays offline.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const { shapeUsageRows, RATES, dayKeysBetween } = require('../src/services/usageReport');

const HAIKU = RATES.perMessageUsd.haiku;
const SONNET = RATES.perMessageUsd.sonnet;

// The report rounds cost to 4dp so sub-cent rates never surface float dust
// (10 * 0.011 is 0.10999999999999999 in IEEE754). Expectations round the same
// way; `cost is rounded to 4dp` below pins the behaviour itself.
const usd = (n) => Math.round(n * 10000) / 10000;

// ---------------------------------------------------------------------------
// 1. Pure shaping
// ---------------------------------------------------------------------------

function row(domain, day, counts = {}) {
  return { _id: { domain, day }, ...counts };
}

test('empty range → no rows and a zeroed grand total', () => {
  const out = shapeUsageRows([], { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(out.days, 30);
  assert.deepEqual(out.rows, []);
  assert.deepEqual(out.entityTotals, []);
  assert.equal(out.total.userMessages, 0);
  assert.equal(out.total.assistantMessages, 0);
  assert.equal(out.total.estimatedCostUsd, 0);
  assert.equal(out.from, '2026-09-01');
  assert.equal(out.to, '2026-09-30');
});

test('sparse days are zero-filled across the whole range, per entity', () => {
  const out = shapeUsageRows(
    [row('a.example.com', '2026-09-02', { userMessages: 2, assistantMessages: 2, haiku: 2 })],
    { from: '2026-09-01', to: '2026-09-03' }
  );
  assert.equal(out.rows.length, 3, 'one dense row per day in the range');
  assert.deepEqual(out.rows.map((r) => r.day), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.equal(out.rows[0].assistantMessages, 0);
  assert.equal(out.rows[0].estimatedCostUsd, 0);
  assert.equal(out.rows[1].assistantMessages, 2);
  assert.equal(out.rows[2].assistantMessages, 0);
});

test('two entities → dense rows for each, sorted by domain then day', () => {
  const out = shapeUsageRows(
    [
      row('b.example.com', '2026-09-02', { assistantMessages: 1, sonnet: 1 }),
      row('a.example.com', '2026-09-01', { assistantMessages: 1, haiku: 1 }),
    ],
    { from: '2026-09-01', to: '2026-09-02' }
  );
  assert.deepEqual(
    out.rows.map((r) => `${r.domain}/${r.day}`),
    ['a.example.com/2026-09-01', 'a.example.com/2026-09-02',
      'b.example.com/2026-09-01', 'b.example.com/2026-09-02']
  );
  assert.deepEqual(out.entityTotals.map((t) => t.domain), ['a.example.com', 'b.example.com']);
});

test('cost = count x per-model rate, summed on the day, entity, and grand total', () => {
  const out = shapeUsageRows(
    [
      row('a.example.com', '2026-09-01', { assistantMessages: 5, haiku: 3, sonnet: 2 }),
      row('b.example.com', '2026-09-02', { assistantMessages: 10, sonnet: 10 }),
    ],
    { from: '2026-09-01', to: '2026-09-02' }
  );
  const byKey = Object.fromEntries(out.rows.map((r) => [`${r.domain}/${r.day}`, r]));
  assert.equal(byKey['a.example.com/2026-09-01'].estimatedCostUsd, usd(3 * HAIKU + 2 * SONNET));
  assert.equal(byKey['b.example.com/2026-09-02'].estimatedCostUsd, usd(10 * SONNET));
  assert.equal(out.entityTotals[0].estimatedCostUsd, usd(3 * HAIKU + 2 * SONNET));
  assert.equal(out.entityTotals[1].estimatedCostUsd, usd(10 * SONNET));
  assert.equal(out.total.estimatedCostUsd, usd(3 * HAIKU + 12 * SONNET));
  assert.equal(out.total.assistantMessages, 15);
});

test('cost is rounded to 4dp — no IEEE754 dust reaches the dashboard', () => {
  const out = shapeUsageRows(
    [row('a.example.com', '2026-09-01', { assistantMessages: 10, sonnet: 10 })],
    { from: '2026-09-01', to: '2026-09-01' }
  );
  // 10 * 0.011 === 0.10999999999999999 unrounded.
  assert.equal(out.rows[0].estimatedCostUsd, 0.11);
  assert.equal(out.total.estimatedCostUsd, 0.11);
});

test('an unrecognised model is counted as otherModel and is NOT priced', () => {
  const out = shapeUsageRows(
    [row('a.example.com', '2026-09-01', { assistantMessages: 4, haiku: 1, sonnet: 1 })],
    { from: '2026-09-01', to: '2026-09-01' }
  );
  assert.equal(out.rows[0].otherModel, 2);
  assert.equal(out.rows[0].estimatedCostUsd, usd(HAIKU + SONNET), 'other models borrow no rate');
});

test('classifierRoute split: unclassified assistant turns land in routeUnknown', () => {
  const out = shapeUsageRows(
    [row('a.example.com', '2026-09-01', { assistantMessages: 5, routeSimple: 2, routeComplex: 1 })],
    { from: '2026-09-01', to: '2026-09-01' }
  );
  assert.equal(out.rows[0].routeSimple, 2);
  assert.equal(out.rows[0].routeComplex, 1);
  assert.equal(out.rows[0].routeUnknown, 2);
});

test('rows outside the range are ignored', () => {
  const out = shapeUsageRows(
    [
      row('a.example.com', '2025-01-01', { assistantMessages: 99, sonnet: 99 }),
      row('a.example.com', '2026-09-01', { assistantMessages: 1, sonnet: 1 }),
    ],
    { from: '2026-09-01', to: '2026-09-01' }
  );
  assert.equal(out.rows.length, 1);
  assert.equal(out.total.assistantMessages, 1);
  assert.equal(out.total.estimatedCostUsd, SONNET);
});

test('duplicate aggregate rows for the same entity/day are summed, not overwritten', () => {
  const out = shapeUsageRows(
    [
      row('a.example.com', '2026-09-01', { assistantMessages: 1, haiku: 1 }),
      row('a.example.com', '2026-09-01', { assistantMessages: 2, haiku: 2 }),
    ],
    { from: '2026-09-01', to: '2026-09-01' }
  );
  assert.equal(out.rows[0].haiku, 3);
});

test('an inverted range yields zero days rather than looping', () => {
  assert.deepEqual(dayKeysBetween('2026-09-05', '2026-09-01'), []);
  const out = shapeUsageRows([row('a.example.com', '2026-09-03', { assistantMessages: 1 })],
    { from: '2026-09-05', to: '2026-09-01' });
  assert.equal(out.days, 0);
  assert.deepEqual(out.rows, []);
});

test('RATES are the documented estimate, labelled as such', () => {
  assert.equal(RATES.perMessageUsd.sonnet, 0.011, "pricing-strategy.md's 'The math' figure");
  // Same ~3,000-in/200-out profile at the Haiku 4.5 list price ($1/$5 per MTok).
  const { inputTokens, outputTokens } = RATES.tokenProfile;
  assert.equal(RATES.perMessageUsd.haiku, (inputTokens / 1e6) * 1 + (outputTokens / 1e6) * 5);
  assert.match(RATES.note, /Estimates only/);
});

// ---------------------------------------------------------------------------
// 2. The route, over mongodb-memory-server
// ---------------------------------------------------------------------------

function stubModule(resolvedPath, exportsObject) {
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true, exports: exportsObject,
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
  embedQuery: async () => { throw new Error('embedQuery must not be called in this suite'); },
  embedTexts: async () => { throw new Error('embedTexts must not be called in this suite'); },
});

stubModule(require.resolve(path.join(srcDir, 'services', 'scraper.js')), { chunkText: () => [] });

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

const adminRouter = require('../src/routes/admin');
const Conversation = require('../src/models/Conversation');

let mongod, server, baseUrl;

const SUPER = JSON.stringify({ superadmin: true });
const MEMBER = JSON.stringify({ memberships: [{ entityDomain: 'a.example.com' }] });

const A = 'a.example.com';
const B = 'b.example.com';
const SONNET_ID = 'claude-sonnet-4-6';
const HAIKU_ID = 'claude-haiku-4-5-20251001';

// Three consecutive days inside the seeded window.
const D1 = '2026-09-01';
const D2 = '2026-09-02';
const D3 = '2026-09-03';

const at = (day, hour) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);

// One visitor turn + one Leo turn, which is what a real exchange writes.
function exchange(day, hour, { model, route }) {
  return [
    { role: 'user', content: 'hi', timestamp: at(day, hour) },
    { role: 'assistant', content: 'hello', timestamp: at(day, hour), model, classifierRoute: route, hadContext: true },
  ];
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await Conversation.insertMany([
    {
      sessionToken: 'a-1', domain: A, lastActiveAt: at(D2, 12),
      messages: [
        ...exchange(D1, 9, { model: SONNET_ID, route: 'complex' }),
        ...exchange(D1, 10, { model: HAIKU_ID, route: 'simple' }),
        ...exchange(D2, 12, { model: HAIKU_ID, route: 'simple' }),
      ],
    },
    {
      sessionToken: 'a-2', domain: A, lastActiveAt: at(D3, 8),
      messages: exchange(D3, 8, { model: SONNET_ID, route: 'complex' }),
    },
    {
      sessionToken: 'b-1', domain: B, lastActiveAt: at(D2, 15),
      messages: [
        ...exchange(D2, 15, { model: SONNET_ID, route: 'complex' }),
        // Pre-analytics turn: no model, no classifierRoute. $regexMatch must
        // not blow up on it, and it must land in otherModel/routeUnknown.
        { role: 'assistant', content: 'legacy', timestamp: at(D2, 16) },
      ],
    },
    {
      // MCP/smoke traffic — must be absent from every row and total.
      sessionToken: 'b-test', domain: B, isTest: true, lastActiveAt: at(D2, 15),
      messages: exchange(D2, 15, { model: SONNET_ID, route: 'complex' }),
    },
    {
      // Outside the queried window entirely.
      sessionToken: 'a-old', domain: A, lastActiveAt: at('2026-08-01', 9),
      messages: exchange('2026-08-01', 9, { model: SONNET_ID, route: 'complex' }),
    },
  ]);
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function report(params, user = SUPER) {
  const qs = new URLSearchParams(params).toString();
  const headers = {};
  if (user) headers['x-test-user'] = user;
  const res = await fetch(`${baseUrl}/api/admin/usage-report?${qs}`, { headers });
  return { status: res.status, body: await res.json() };
}

test('route: dense entity x day rows over the seeded three days', async () => {
  const { status, body } = await report({ from: D1, to: D3 });
  assert.equal(status, 200);
  assert.equal(body.days, 3);
  assert.equal(body.rows.length, 6, '2 entities x 3 days');
  const byKey = Object.fromEntries(body.rows.map((r) => [`${r.domain}/${r.day}`, r]));

  assert.deepEqual(
    { u: byKey[`${A}/${D1}`].userMessages, a: byKey[`${A}/${D1}`].assistantMessages,
      h: byKey[`${A}/${D1}`].haiku, s: byKey[`${A}/${D1}`].sonnet },
    { u: 2, a: 2, h: 1, s: 1 }
  );
  assert.equal(byKey[`${A}/${D1}`].estimatedCostUsd, usd(HAIKU + SONNET));

  assert.equal(byKey[`${A}/${D2}`].haiku, 1);
  assert.equal(byKey[`${A}/${D3}`].sonnet, 1);

  // B has nothing on D1/D3 — still present, zeroed.
  assert.equal(byKey[`${B}/${D1}`].assistantMessages, 0);
  assert.equal(byKey[`${B}/${D3}`].assistantMessages, 0);
});

test('route: isTest conversations never appear in any row or total', async () => {
  const { body } = await report({ from: D1, to: D3 });
  const b = body.entityTotals.find((t) => t.domain === B);
  // Only the real b-1 conversation: 1 user + 2 assistant (one of them legacy).
  assert.equal(b.userMessages, 1);
  assert.equal(b.assistantMessages, 2);
  assert.equal(b.sonnet, 1, 'the isTest sonnet message is excluded');
});

test('route: a message with no model/classifierRoute lands in the derived buckets', async () => {
  const { body } = await report({ from: D1, to: D3 });
  const row = body.rows.find((r) => r.domain === B && r.day === D2);
  assert.equal(row.assistantMessages, 2);
  assert.equal(row.otherModel, 1);
  assert.equal(row.routeUnknown, 1);
  assert.equal(row.estimatedCostUsd, SONNET, 'the unpriced legacy turn adds nothing');
});

test('route: per-entity totals and the grand total add up', async () => {
  const { body } = await report({ from: D1, to: D3 });
  const a = body.entityTotals.find((t) => t.domain === A);
  assert.deepEqual({ u: a.userMessages, a: a.assistantMessages, h: a.haiku, s: a.sonnet },
    { u: 4, a: 4, h: 2, s: 2 });
  assert.equal(a.routeSimple, 2);
  assert.equal(a.routeComplex, 2);
  assert.equal(a.estimatedCostUsd, usd(2 * HAIKU + 2 * SONNET));

  assert.equal(body.total.assistantMessages, 6);
  assert.equal(body.total.estimatedCostUsd, usd(2 * HAIKU + 3 * SONNET));
});

test('route: messages outside the window are excluded', async () => {
  const { body } = await report({ from: D2, to: D3 });
  assert.equal(body.days, 2);
  const a = body.entityTotals.find((t) => t.domain === A);
  assert.equal(a.assistantMessages, 2, 'the D1 pair and the August conversation are both out');
});

test('route: default window is the last 30 days and still returns a shaped payload', async () => {
  const { status, body } = await report({});
  assert.equal(status, 200);
  assert.equal(body.days, 30);
  assert.equal(body.to, new Date().toISOString().slice(0, 10));
  assert.ok(Array.isArray(body.rows));
});

test('route: rates travel with the payload so the UI can label the estimate', async () => {
  const { body } = await report({ from: D1, to: D1 });
  assert.equal(body.rates.perMessageUsd.sonnet, SONNET);
  assert.match(body.rates.note, /Estimates only/);
});

test('route: a range over 92 days is a 400', async () => {
  const { status, body } = await report({ from: '2026-01-01', to: '2026-09-01' });
  assert.equal(status, 400);
  assert.match(body.error, /Range too large/);
});

test('route: a malformed or impossible date is a 400, not a 500', async () => {
  assert.equal((await report({ from: 'yesterday', to: D3 })).status, 400);
  assert.equal((await report({ from: D1, to: '2026-02-31' })).status, 400);
  assert.equal((await report({ from: D3, to: D1 })).status, 400);
});

test('route: a 92-day range is allowed (the boundary is inclusive)', async () => {
  const { status, body } = await report({ from: '2026-06-02', to: '2026-09-01' });
  assert.equal(status, 200);
  assert.equal(body.days, 92);
});

test('route: non-superadmin is forbidden, unauthenticated is rejected', async () => {
  assert.equal((await report({ from: D1, to: D3 }, MEMBER)).status, 403);
  assert.equal((await report({ from: D1, to: D3 }, null)).status, 401);
});
