// Owner-facing KB search — text mode (LEO-033).
//
// Drives the REAL knowledge router over HTTP against an in-memory MongoDB.
// The auth middleware is stubbed to inject a user from a test header, the
// embeddings service is stubbed (semantic mode needs real Atlas $vectorSearch
// and is NOT testable offline — verified post-deploy instead), and the scraper
// module is stubbed so requiring the router never loads puppeteer.
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
  embedQuery: async () => { throw new Error('semantic mode is not offline-testable'); },
});

stubModule(require.resolve(path.join(srcDir, 'services', 'scraper.js')), {
  chunkText: () => [],
});

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

const knowledgeRouter = require('../src/routes/knowledge');
const Chunk = require('../src/models/Chunk');

let mongod;
let server;
let baseUrl;

const MEMBER = JSON.stringify({ memberships: [{ entityDomain: 'a.example.com' }] });
const OTHER_MEMBER = JSON.stringify({ memberships: [{ entityDomain: 'b.example.com' }] });
const SUPER = JSON.stringify({ superadmin: true });

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  // Same mount shape as index.js — :domain comes from the parent path.
  const app = express();
  app.use(express.json());
  app.use('/api/dashboard/entities/:domain/kb', knowledgeRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const emb = [0.1, 0.2];
  await Chunk.insertMany([
    { domain: 'a.example.com', url: 'https://a.example.com/hours', content: 'We open at 9am every day (except holidays).', embedding: emb, source: 'scraped', label: 'Hours', pageH1: 'Visit Us' },
    { domain: 'a.example.com', url: 'https://a.example.com/menu', content: 'Fresh bagels daily. Coffee from 7am.', embedding: emb, source: 'scraped' },
    { domain: 'b.example.com', url: 'https://b.example.com/hours', content: 'B-site opens at 9am on weekdays.', embedding: emb, source: 'scraped' },
    // Regex-metacharacter content — searchable only if q is escaped correctly
    { domain: 'a.example.com', url: 'https://a.example.com/pricing', content: 'Special deal: $5.99 (limited). Terms: a+b applies.', embedding: emb, source: 'manual', label: 'Pricing' },
  ]);
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function search(domain, params, user) {
  const qs = new URLSearchParams(params).toString();
  const headers = {};
  if (user) headers['x-test-user'] = user;
  const res = await fetch(`${baseUrl}/api/dashboard/entities/${domain}/kb/search?${qs}`, { headers });
  return { status: res.status, body: await res.json() };
}

test('text mode finds a literal substring, case-insensitively', async () => {
  const { status, body } = await search('a.example.com', { q: '9AM', mode: 'text' }, MEMBER);
  assert.equal(status, 200);
  assert.equal(body.mode, 'text');
  assert.equal(body.total, 1);
  assert.equal(body.results[0].url, 'https://a.example.com/hours');
  assert.equal(body.results[0].label, 'Hours');
  assert.equal(body.results[0].pageH1, 'Visit Us');
  assert.equal(body.results[0].source, 'scraped');
});

test('domain scoping: a hit on domain B never surfaces for domain A', async () => {
  const { body } = await search('a.example.com', { q: '9am', mode: 'text' }, MEMBER);
  assert.ok(body.results.every((r) => r.url.startsWith('https://a.example.com/')),
    'must only return domain A chunks');
  assert.ok(!body.results.some((r) => r.snippet.includes('B-site')));
});

test('membership floor: a member of B cannot search A at all', async () => {
  const { status } = await search('a.example.com', { q: '9am', mode: 'text' }, OTHER_MEMBER);
  assert.equal(status, 403);
});

test('unauthenticated requests are rejected', async () => {
  const { status } = await search('a.example.com', { q: '9am', mode: 'text' }, null);
  assert.equal(status, 401);
});

test('superadmin passes the floor for any domain', async () => {
  const { status, body } = await search('b.example.com', { q: '9am', mode: 'text' }, SUPER);
  assert.equal(status, 200);
  assert.equal(body.total, 1);
  assert.equal(body.results[0].url, 'https://b.example.com/hours');
});

test('regex metacharacters in q are treated as literals', async () => {
  // "$5.99 (limited)" — $, ., ( ) must all match literally, not as regex syntax
  const { status, body } = await search('a.example.com', { q: '$5.99 (limited)', mode: 'text' }, MEMBER);
  assert.equal(status, 200);
  assert.equal(body.total, 1);
  assert.equal(body.results[0].url, 'https://a.example.com/pricing');
});

test('a regex-metacharacter query that matches nothing returns empty, not 500', async () => {
  const { status, body } = await search('a.example.com', { q: 'a+b applies', mode: 'text' }, MEMBER);
  assert.equal(status, 200);
  assert.equal(body.total, 1, 'literal "a+b applies" exists in the pricing chunk');
  const none = await search('a.example.com', { q: '((((', mode: 'text' }, MEMBER);
  assert.equal(none.status, 200);
  assert.equal(none.body.total, 0);
});

test('snippet marks the match position for frontend highlighting', async () => {
  const { body } = await search('a.example.com', { q: '9am', mode: 'text' }, MEMBER);
  const r = body.results[0];
  assert.ok(r.matchStart >= 0);
  assert.equal(r.matchLength, 3);
  assert.equal(r.snippet.slice(r.matchStart, r.matchStart + r.matchLength).toLowerCase(), '9am');
});

test('empty q is a 400', async () => {
  const { status } = await search('a.example.com', { q: '  ', mode: 'text' }, MEMBER);
  assert.equal(status, 400);
});
