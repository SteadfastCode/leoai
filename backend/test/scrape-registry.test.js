// Active-scrape registry (LEO-078) — the Map behind `GET /scrape/active`.
//
// Two halves. First the registry itself, which is pure in-process state and
// needs no harness. Then the REAL scrape router driven over HTTP, in the shape
// of test/kb-search.test.js: the auth middleware is stubbed so a JWT user and
// an X-API-Key principal can both be injected from a header, and the scraper
// module is stubbed so requiring the router never loads puppeteer. No Mongo —
// `/active` reads the registry and touches no model.
//
// What matters here is that the endpoint and LeoRefresh share ONE Map. Before
// this item the Map was private to routes/scrape.js, so a nightly rescrape ran
// for minutes with `/active` answering `[]` — blinding the dashboard and the
// routine's own mid-crawl merge gate.
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

// Fake auth, mirroring the real middleware's two accepted principals:
//   x-api-key   → the synthetic superadmin principal (how the MCP server and
//                 the routine's gate call this endpoint)
//   x-test-user → a JSON user object, standing in for a verified JWT
stubModule(require.resolve(path.join(srcDir, 'middleware', 'auth.js')), {
  requireAuth: () => (req, res, next) => {
    if (req.headers['x-api-key'] === 'test-admin-key') {
      req.apiKey = { label: 'test' };
      req.user = { isApiKey: true, memberships: [{ entityDomain: '*', roles: ['superadmin'] }] };
      return next();
    }
    const raw = req.headers['x-test-user'];
    if (!raw) return res.status(401).json({ error: 'Unauthorized' });
    req.user = JSON.parse(raw);
    next();
  },
  // Same predicate as the real one — the role, not the domain.
  isSuperAdmin: (user) => user?.memberships?.some((m) => m.roles?.includes('superadmin')) ?? false,
});

// Keeps puppeteer out of the process. `/active` calls neither of these.
stubModule(require.resolve(path.join(srcDir, 'services', 'scraper.js')), {
  scrapeSite: async () => { throw new Error('scrapeSite must not be called in this suite'); },
  rescrapeSite: async () => { throw new Error('rescrapeSite must not be called in this suite'); },
  chunkText: () => [],
});

const express = require('express');

const registry = require('../src/services/scrapeRegistry');
const scrapeRouter = require('../src/routes/scrape');

const OWNER = JSON.stringify({ memberships: [{ entityDomain: 'a.example.com', roles: ['owner'] }] });
const SUPER = JSON.stringify({ memberships: [{ entityDomain: '*', roles: ['superadmin'] }] });

let server;
let baseUrl;

test.before(async () => {
  // Same mount shape as index.js.
  const app = express();
  app.use(express.json());
  app.use('/scrape', scrapeRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

// The registry is module state shared by every test in this file, so each one
// leaves it empty rather than trusting the order they run in.
function clearRegistry() {
  for (const { domain } of registry.list()) registry.end(domain);
}

// ---------------------------------------------------------------- the registry

test('begin registers an entry that list() reports with its source', () => {
  clearRegistry();
  registry.begin('a.example.com', { url: 'https://a.example.com', name: 'A', mode: 'full', source: 'manual' });

  const entries = registry.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].domain, 'a.example.com');
  assert.equal(entries[0].source, 'manual');
  assert.equal(entries[0].mode, 'full');
  assert.equal(entries[0].url, 'https://a.example.com');
  assert.equal(entries[0].name, 'A');
  assert.ok(entries[0].startedAt instanceof Date, 'startedAt is stamped by the registry');
  assert.equal(registry.isActive('a.example.com'), true);
  clearRegistry();
});

test('a leorefresh crawl is visible on the same registry as a manual one', () => {
  clearRegistry();
  registry.begin('a.example.com', { url: 'https://a.example.com', name: 'A', mode: 'full', source: 'manual' });
  registry.begin('b.example.com', { url: 'https://b.example.com', name: 'B', mode: 'rescrape', source: 'leorefresh' });

  const bySource = Object.fromEntries(registry.list().map((e) => [e.domain, e.source]));
  assert.deepEqual(bySource, { 'a.example.com': 'manual', 'b.example.com': 'leorefresh' });
  clearRegistry();
});

test('end removes the entry and leaves the registry empty', () => {
  clearRegistry();
  registry.begin('a.example.com', { source: 'manual' });
  assert.equal(registry.end('a.example.com'), true);
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.isActive('a.example.com'), false);
});

test('a second begin for a live domain does not duplicate it, and keeps the running crawl', () => {
  clearRegistry();
  const first = registry.begin('a.example.com', { mode: 'full', source: 'manual' });
  const second = registry.begin('a.example.com', { mode: 'rescrape', source: 'leorefresh' });

  assert.equal(registry.list().length, 1, 'one domain, one entry');
  // The entry must keep describing the crawl that is actually running: `end` is
  // a single delete, so an overwrite would let the first finisher clear it while
  // the second was still mid-flight.
  assert.equal(second, first);
  assert.equal(registry.list()[0].source, 'manual');
  assert.equal(registry.list()[0].startedAt.getTime(), first.startedAt.getTime());
  clearRegistry();
});

test('end on an unknown domain is a no-op, not a throw', () => {
  clearRegistry();
  registry.begin('a.example.com', { source: 'manual' });
  assert.equal(registry.end('never-registered.example.com'), false);
  assert.equal(registry.list().length, 1, 'the live entry is untouched');
  assert.equal(registry.end(undefined), false);
  clearRegistry();
});

test('a body that throws still clears its entry via finally', async () => {
  clearRegistry();
  const boom = async () => {
    registry.begin('a.example.com', { mode: 'rescrape', source: 'leorefresh' });
    try {
      throw new Error('rescrape blew up');
    } finally {
      registry.end('a.example.com');
    }
  };

  await assert.rejects(boom, /rescrape blew up/);
  // The gate reads this endpoint: an entry left behind by a failed nightly
  // rescrape would defer every merge until the container restarted.
  assert.deepEqual(registry.list(), []);
});

test('an absent source records as manual — the only writer before this item', () => {
  clearRegistry();
  registry.begin('a.example.com', { url: 'https://a.example.com' });
  assert.equal(registry.list()[0].source, 'manual');
  clearRegistry();
});

// ------------------------------------------------------ GET /scrape/active

async function getActive(headers) {
  const res = await fetch(`${baseUrl}/scrape/active`, { headers });
  const body = res.status === 200 ? await res.json() : null;
  return { status: res.status, body };
}

test('GET /scrape/active rejects a non-superadmin JWT', async () => {
  clearRegistry();
  const { status } = await getActive({ 'x-test-user': OWNER });
  assert.equal(status, 403);
});

test('GET /scrape/active rejects an unauthenticated request', async () => {
  const { status } = await getActive({});
  assert.equal(status, 401);
});

test('GET /scrape/active returns [] for the admin key when idle', async () => {
  clearRegistry();
  const { status, body } = await getActive({ 'x-api-key': 'test-admin-key' });
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

test('GET /scrape/active reports a registered LeoRefresh crawl to the admin key', async () => {
  clearRegistry();
  registry.begin('a.example.com', { url: 'https://a.example.com', name: 'A', mode: 'rescrape', source: 'leorefresh' });

  const { status, body } = await getActive({ 'x-api-key': 'test-admin-key' });
  assert.equal(status, 200);
  assert.equal(body.length, 1, 'the gate must see the one crawl that runs unattended');
  // Every field the old route returned, plus source.
  assert.equal(body[0].domain, 'a.example.com');
  assert.equal(body[0].url, 'https://a.example.com');
  assert.equal(body[0].name, 'A');
  assert.equal(body[0].mode, 'rescrape');
  assert.equal(body[0].source, 'leorefresh');
  assert.ok(Date.parse(body[0].startedAt) > 0, 'startedAt serialises to a date');
  clearRegistry();
});

test('a superadmin JWT sees the same entry as the admin key', async () => {
  clearRegistry();
  registry.begin('a.example.com', { url: 'https://a.example.com', name: 'A', mode: 'full', source: 'manual' });

  const { status, body } = await getActive({ 'x-test-user': SUPER });
  assert.equal(status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].source, 'manual');
  clearRegistry();
});

test('GET /scrape/active goes back to [] once the crawl ends', async () => {
  clearRegistry();
  registry.begin('a.example.com', { mode: 'rescrape', source: 'leorefresh' });
  registry.end('a.example.com');

  const { status, body } = await getActive({ 'x-api-key': 'test-admin-key' });
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});
