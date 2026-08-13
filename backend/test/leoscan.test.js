// LeoScan pattern scanner (LEO-021).
//
// Two halves:
//   1. Pure unit tests on scanText() — one positive fixture per rule, the
//      deliberate exclusions, and the check that actually decides safety: a
//      committed negative corpus of 28 real scraped chunks (menu text, prices,
//      phone numbers, addresses, SKUs) that must all come back clean.
//   2. HTTP tests driving the real knowledge router against in-memory MongoDB,
//      proving a flagged upload 422s with a flags array AND leaves previously
//      ingested chunks untouched (the scan must run before the idempotent
//      re-upload deleteMany).
//
// All secrets below are fabricated fixtures, not real credentials.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const { scanText } = require('../src/services/leoscan');

// ── Unit: positives, one per rule ──────────────────────────────────────────

test('flags a labelled password', () => {
  const flags = scanText('Our wifi is great. password: hunter2AB');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].rule, 'labelled_password');
});

test('flags labelled password variants (pwd=, passphrase:)', () => {
  assert.equal(scanText('pwd=s3cretval')[0].rule, 'labelled_password');
  assert.equal(scanText('passphrase : correct-horse-battery')[0].rule, 'labelled_password');
});

test('flags common API key prefixes', () => {
  const cases = [
    'sk-abcdefghijklmnopqrstuv1234',                 // OpenAI/Anthropic style
    'sk_live_abcdefghijklmnop',                      // Stripe secret
    'AKIAIOSFODNN7EXAMPLE',                          // AWS access key id
    'ghp_' + 'a'.repeat(36),                         // GitHub PAT
    'xoxb-1234567890-abcdefghij',                    // Slack bot token
    'AIza' + 'A'.repeat(35),                         // Google API key
    'SG.abcdefghijklmnop.qrstuvwxyz1234567890',      // SendGrid
  ];
  for (const key of cases) {
    const flags = scanText(`config value ${key} end`);
    assert.equal(flags.length, 1, `expected flag for ${key.slice(0, 8)}…`);
    assert.equal(flags[0].rule, 'api_key');
  }
});

test('flags a JWT', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlRlc3QifQ.TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ';
  const flags = scanText(`bearer ${jwt} attached`);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].rule, 'jwt');
});

test('flags a PEM BEGIN block', () => {
  const flags = scanText('-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----');
  assert.ok(flags.some(f => f.rule === 'pem_block'));
});

test('flags a dashed SSN', () => {
  const flags = scanText('My social is 123-45-6789 thanks');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].rule, 'ssn');
});

test('flags Luhn-valid card numbers, plain and grouped', () => {
  // Standard test PANs (Luhn-valid by construction, not real accounts)
  const plain = scanText('card 4111111111111111 on file');
  assert.equal(plain.length, 1);
  assert.equal(plain[0].rule, 'card_number');

  const grouped = scanText('card 4111 1111 1111 1111 on file');
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].rule, 'card_number');

  const amex = scanText('amex 378282246310005'); // 15-digit
  assert.equal(amex.length, 1);
  assert.equal(amex[0].rule, 'card_number');
});

// ── Unit: deliberate exclusions and near-misses ────────────────────────────

test('does NOT flag bank routing numbers (deliberate exclusion)', () => {
  // 9-digit ABA routing numbers collide with product SKUs — excluded by spec.
  assert.deepEqual(scanText('Routing number 031101279, account at the local bank'), []);
});

test('does NOT flag prose containing the word password without a value', () => {
  assert.deepEqual(scanText('This page is password protected. Reset your password any time.'), []);
});

test('does NOT flag Luhn-failing digit runs or wrong lengths', () => {
  assert.deepEqual(scanText('Order 4111111111111112 shipped'), []);   // Luhn fails
  assert.deepEqual(scanText('Tracking 12345678901234567890'), []);    // 20 digits — not a 13-16 run
  assert.deepEqual(scanText('Call 717-555-0123 or 7175550123'), []);  // phone shapes
});

test('previews are redacted — full match never echoed back', () => {
  const flags = scanText('password: superSecretValue12345');
  assert.equal(flags.length, 1);
  assert.ok(!flags[0].preview.includes('superSecretValue12345'));
  assert.ok(flags[0].preview.length < 30);
});

// ── The check that decides safety: real-chunk negative corpus ──────────────

test('negative corpus: every real scraped chunk comes back clean', () => {
  const corpus = require('./fixtures/leoscan-negative-corpus.json');
  assert.ok(corpus.length >= 20 && corpus.length <= 30, `corpus size ${corpus.length} outside 20-30`);
  for (const chunk of corpus) {
    const flags = scanText(chunk.content);
    assert.deepEqual(
      flags,
      [],
      `false positive on ${chunk.domain} ${chunk.url}: ${JSON.stringify(flags)}`
    );
  }
});

// ── HTTP: 422 wiring in ingestText, scan-before-delete ─────────────────────

function stubModule(resolvedPath, exportsObject) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsObject,
  };
}

const srcDir = path.join(__dirname, '..', 'src');

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
  embedTexts: async (texts) => texts.map(() => Array(512).fill(0)),
  embedQuery: async () => { throw new Error('not used in this suite'); },
});

stubModule(require.resolve(path.join(srcDir, 'services', 'scraper.js')), {
  chunkText: (text, url) => [{ content: text, url }],
});

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

const knowledgeRouter = require('../src/routes/knowledge');
const Chunk = require('../src/models/Chunk');

const MEMBER = JSON.stringify({ memberships: [{ entityDomain: 'a.example.com' }] });

let mongod;
let server;
let baseUrl;

test('HTTP ingest wiring', async (t) => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const app = express();
  app.use(express.json());
  app.use('/api/dashboard/entities/:domain/kb', knowledgeRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const post = (body) => fetch(`${baseUrl}/api/dashboard/entities/a.example.com/kb/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': MEMBER },
    body: JSON.stringify(body),
  });

  await t.test('clean content ingests normally', async () => {
    const r = await post({ title: 'Hours', content: 'We are open Monday to Friday, 9am to 5pm. Closed Sundays.' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(await Chunk.countDocuments({ domain: 'a.example.com', label: 'Hours' }), 1);
  });

  await t.test('flagged content 422s with a flags array', async () => {
    const r = await post({ title: 'Wifi', content: 'Guest wifi password: hunter2AB for customers' });
    assert.equal(r.status, 422);
    const j = await r.json();
    assert.ok(Array.isArray(j.flags) && j.flags.length >= 1);
    assert.equal(j.flags[0].rule, 'labelled_password');
    assert.equal(await Chunk.countDocuments({ domain: 'a.example.com', label: 'Wifi' }), 0);
  });

  await t.test('flagged re-upload leaves the existing chunks intact', async () => {
    // The scan must run BEFORE the idempotent-re-upload deleteMany: a rejected
    // replacement must not wipe what was there.
    const r = await post({ title: 'Hours', content: 'New hours. Also our admin password: oops12345' });
    assert.equal(r.status, 422);
    const kept = await Chunk.find({ domain: 'a.example.com', label: 'Hours' }).lean();
    assert.equal(kept.length, 1);
    assert.match(kept[0].content, /Closed Sundays/);
  });

  await mongoose.disconnect();
  await mongod.stop();
  server.close();
});
