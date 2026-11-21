// Deterministic crawl order (LEO-138).
//
// The real scrapeSite(), driven against a local fixture site, twice — with the
// per-page response delays REVERSED between the two runs so the five concurrent
// fetches in a batch finish in the opposite order. The chunks must be identical.
//
// Why that is a real test and not a tautology: the crawl pushed every fetched
// page onto its lists from inside the concurrent callback, so the list order WAS
// the completion order, and three separate things read it —
//
//   * paragraph dedup keeps the first page a short paragraph appears on, so the
//     contested paragraph below (on /b, /c and /d, all in one batch) belonged to
//     whichever of the three answered first;
//   * thin pages are packed into a group chunk in list order, so the group
//     chunk's TEXT, and therefore its hash, followed the same race;
//   * links are resolved per page, so the crawl queue did too.
//
// Everything that needs the network, Puppeteer, Voyage or Claude is stubbed
// through require.cache before the service loads; the fixture HTTP server is the
// only I/O, and it is the point.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'src');

function stubModule(resolvedPath, exportsObject) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsObject,
  };
}

// --- stubs ------------------------------------------------------------------

// A fixed-length embedding per text: this suite asserts on chunk TEXT, and a
// real Voyage call would make it a network test for no added coverage.
stubModule(require.resolve(path.join(srcDir, 'services', 'embeddings.js')), {
  embedTexts: async (texts) => texts.map(() => [0.1, 0.2]),
});
stubModule(require.resolve(path.join(srcDir, 'services', 'claude.js')), {
  analyzePageStructure: async () => ({ exclude: [], include: [] }),
});
// A browser object that is truthy (so the JS-framework check still runs) and
// closeable, with the page pool rigged to throw: every fixture page is
// server-rendered and carries an H1, so Pass 2 must never be reached. If one
// ever is, fetchPage catches the throw and falls back to the cheerio text —
// which is what the assertions compare, so the suite stays meaningful either way.
stubModule(require.resolve(path.join(srcDir, 'services', 'puppeteerNav.js')), {
  launchBrowser: async () => ({ close: async () => {} }),
  acquirePage: async () => { throw new Error('Puppeteer is not available in this suite'); },
  releasePage: () => {},
  navigate: async () => {},
  noteFallback: () => {},
  puppeteerSummary: () => null,
});
// robots.txt lives one request away from every fixture page; the crawl's own
// gate is what this suite is NOT testing.
stubModule(require.resolve(path.join(srcDir, 'services', 'robots.js')), {
  LEO_USER_AGENT: 'LeoAI-test/1.0',
  shouldSkipUrl: async () => false,
  summariseRobots: () => {},
});

const { scrapeSite } = require('../src/services/scraper');
const { orderPages, makeLinkQueue, compareUrls } = require('../src/services/scrapeOrder');

// --- fixture site -----------------------------------------------------------

// Short enough to be deduped (BOILERPLATE_MAX is 200), and placed on three pages
// of ONE batch so that which page keeps it is decided purely by list order.
const CONTESTED = 'We are open Tuesday through Saturday from nine in the morning until five in the afternoon, and closed on Sundays and Mondays.';

const unique = (name) => `This is the body copy that belongs to the ${name} page and nowhere else on the fixture site. `
  + `It is deliberately long enough to clear the thin-page threshold on its own, so the ${name} page is chunked as a normal page `
  + `rather than being held back and folded into a multi-URL group chunk with the staff cards. ${name} ${name} ${name}.`;

const SPOKES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const STAFF = ['ann', 'bob', 'cid'];

function pageHtml(title, paragraphs, links = []) {
  return `<!doctype html><html><head><title>${title}</title></head><body>`
    + `<h1>${title}</h1>`
    + paragraphs.map((p) => `<p>${p}</p>`).join('')
    + links.map((href) => `<a href="${href}">${href}</a>`).join('')
    + '</body></html>';
}

// Home links every spoke and every staff card, in a fixed document order.
const ROUTES = {
  '/': pageHtml('Fixture Home', [unique('home')], [...SPOKES.map((s) => `/${s}`), ...STAFF.map((s) => `/staff/${s}`)]),
};
for (const s of SPOKES) {
  // /b, /c and /d all carry the contested paragraph.
  const paras = ['b', 'c', 'd'].includes(s) ? [unique(s), CONTESTED] : [unique(s)];
  ROUTES[`/${s}`] = pageHtml(`Spoke ${s.toUpperCase()}`, paras, ['/']);
}
for (const s of STAFF) {
  // Thin on purpose: a name and an address is all a staff card has.
  ROUTES[`/staff/${s}`] = pageHtml(s.toUpperCase(), [`${s}@fixture.test`], ['/']);
}

let server;
let baseUrl;
// Mutated between the two runs — the whole experiment.
let delays = {};

function delayFor(pathname) {
  return delays[pathname] ?? 0;
}

test.before(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const body = ROUTES[pathname];
    const send = () => {
      if (!body) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body>not found</body></html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    const ms = delayFor(pathname);
    if (ms > 0) setTimeout(send, ms);
    else send();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // One server, one port, for BOTH runs: the chunk text carries a [Source: url]
  // line, so a second port would make the two runs differ for a reason that has
  // nothing to do with ordering.
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

// Collect through onChunks — the production path. Without the callback scrapeSite
// embeds everything in one pass at the end, which is exactly the batching this
// suite needs to exercise.
async function crawl(delayMap) {
  delays = delayMap;
  const emitted = [];
  await scrapeSite(baseUrl, {
    crawlSettings: {},
    onChunks: async (chunks) => {
      for (const c of chunks) emitted.push({ url: c.url, content: c.content });
    },
  });
  return emitted;
}

const FAST_B = { '/b': 2, '/c': 30, '/d': 60, '/staff/ann': 2, '/staff/bob': 30, '/staff/cid': 60 };
const FAST_D = { '/b': 60, '/c': 30, '/d': 2, '/staff/ann': 60, '/staff/bob': 30, '/staff/cid': 2 };

let runB;
let runD;

test('two crawls of the same site produce byte-identical chunks, whatever order the fetches finish in', async () => {
  runB = await crawl(FAST_B);
  runD = await crawl(FAST_D);

  assert.ok(runB.length > 0, 'the fixture crawl must produce chunks at all');
  assert.deepEqual(
    runD.map((c) => `${c.url}\n${c.content}`),
    runB.map((c) => `${c.url}\n${c.content}`),
    'same site, same chunks — including which page owns each chunk and the order they are emitted in'
  );
});

test('the contested paragraph is owned by the alphabetically first page that carries it', async () => {
  const owners = runB.filter((c) => c.content.includes(CONTESTED)).map((c) => c.url);
  assert.deepEqual(owners, [`${baseUrl}/b`], 'dedup must keep the paragraph on /b, not on whichever page answered first');
  assert.deepEqual(
    runD.filter((c) => c.content.includes(CONTESTED)).map((c) => c.url),
    owners,
    'and the owner must not move when /d answers first'
  );
});

test('the cards inside a group chunk are packed in canonical URL order', async () => {
  const group = runB.filter((c) => c.url === `${baseUrl}/staff`);
  assert.equal(group.length, 1, 'the three thin staff pages must land in one group chunk');
  const positions = STAFF.map((s) => group[0].content.indexOf(`${s}@fixture.test`));
  assert.ok(positions.every((p) => p >= 0), `every staff card must be in the group chunk: ${group[0].content}`);
  assert.deepEqual([...positions].sort((x, y) => x - y), positions, 'ann, bob, cid — in that order, every run');
});

// --- the helper, on its own -------------------------------------------------

test('orderPages sorts by URL in place and is stable for equal URLs', () => {
  const pages = [{ url: 'https://x.test/c' }, { url: 'https://x.test/a', n: 1 }, { url: 'https://x.test/a', n: 2 }, { url: 'https://x.test/b' }];
  const out = orderPages(pages);
  assert.equal(out, pages, 'the caller\'s own array must be the sorted one');
  assert.deepEqual(out.map((p) => p.url), ['https://x.test/a', 'https://x.test/a', 'https://x.test/b', 'https://x.test/c']);
  assert.deepEqual(out.filter((p) => p.n).map((p) => p.n), [1, 2], 'equal URLs keep insertion order');
});

test('orderPages tolerates the empty and single-page cases', () => {
  assert.deepEqual(orderPages([]), []);
  assert.deepEqual(orderPages(undefined), []);
  assert.deepEqual(orderPages([{ url: 'https://x.test/only' }]).length, 1);
});

test('compareUrls does not depend on locale collation', () => {
  // A locale-aware comparison sorts these the other way round in several locales.
  assert.ok(compareUrls({ url: 'https://x.test/Z' }, { url: 'https://x.test/a' }) < 0);
});

test('makeLinkQueue replays a batch in page order, not note order', () => {
  const queue = [];
  const lq = makeLinkQueue(queue);
  lq.note('https://x.test/z1', 'https://x.test/z', false);
  lq.note('https://x.test/a1', 'https://x.test/a', false);
  lq.note('https://x.test/a2', 'https://x.test/a', false);
  lq.note('https://x.test/m1', 'https://x.test/m', false);
  assert.deepEqual(queue, [], 'nothing reaches the queue until the batch has settled');
  assert.equal(lq.flush(), 4);
  assert.deepEqual(queue, ['https://x.test/a1', 'https://x.test/a2', 'https://x.test/m1', 'https://x.test/z1']);
  assert.equal(lq.flush(), 0, 'a second flush replays nothing');
});

test('makeLinkQueue keeps the subdomain-first priority the crawl relies on', () => {
  const queue = ['https://x.test/existing'];
  const lq = makeLinkQueue(queue);
  lq.note('https://x.test/page', 'https://x.test/a', false);
  lq.note('https://shop.x.test/thing', 'https://x.test/a', true);
  lq.flush();
  assert.equal(queue[0], 'https://shop.x.test/thing', 'a subdomain link goes to the front of the queue');
  assert.equal(queue[queue.length - 1], 'https://x.test/page');
});
