// Pages the crawl never learned (LEO-056).
//
// Drives the REAL scrapeSite against a local HTTP server serving four URLs —
// two good pages, one 404, and one that answers 200 with an empty body — with
// embeddings, the Haiku structural call and Puppeteer stubbed. Fully offline:
// no browser, no network beyond 127.0.0.1, no database.
//
// Before this item the 404 and the empty page were dropped with a console
// warning: no ScrapedPage row, nothing in the result, so the owner's "N pages"
// was silently short. The crawl must still resolve, still chunk the two good
// pages, and now account for all four URLs.
//
// The harness is the one from scrape-embed-containment.test.js (LEO-019), which
// covers the OTHER way a URL is lost: embedding failure after a clean fetch.

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

stubModule(require.resolve(path.join(srcDir, 'services', 'embeddings.js')), {
  embedTexts: async (texts) => texts.map(() => [0.1, 0.2]),
  embedQuery: async () => [0.1, 0.2],
});

stubModule(require.resolve(path.join(srcDir, 'services', 'claude.js')), {
  analyzePageStructure: async () => ({ exclude: [], include: [] }),
});

// scrapeSite launches a browser unconditionally. The empty page has no H1, so the
// Puppeteer fallback IS attempted for it — this stub has no newPage, the fallback
// throws, and fetchPage falls through to the empty cheerio text. That is exactly
// the production shape of "still empty after the render fallback".
stubModule(require.resolve('puppeteer'), {
  launch: async () => ({ close: async () => {} }),
});

const { scrapeSite } = require('../src/services/scraper');
const { shapeFailedUrls } = require('../src/services/scrapePersist');

// Unique long paragraphs per page so seenParaHashes dedup never empties a page.
function goodPage(n, links = '') {
  const filler = `Page ${n} paragraph. ` + `Unique content for page number ${n} — `.repeat(12) + 'End.';
  return `<html><body><h1>Page ${n} Title</h1><p>${filler}</p>${links}</body></html>`;
}

let server;
let baseUrl;
const urls = {};

test.before(async () => {
  server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/' || p === '/good') {
      const links = p === '/'
        ? ['good', 'missing', 'empty'].map((u) => `<a href="/${u}">${u}</a>`).join(' ')
        : '';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(goodPage(p === '/' ? 0 : 1, links));
    }
    if (p === '/empty') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><body></body></html>');
    }
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<html><body>Not found</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  baseUrl = `${origin}/`;
  Object.assign(urls, {
    root: baseUrl,
    good: `${origin}/good`,
    missing: `${origin}/missing`,
    empty: `${origin}/empty`,
  });
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

test('scrapeSite accounts for every URL it could not learn', async () => {
  const result = await scrapeSite(baseUrl);

  // The crawl resolved rather than unwinding on the 404.
  assert.ok(Array.isArray(result.failedUrls), 'failedUrls must be an array');

  // All four URLs are accounted for: fetched (pageData) or reported (failedUrls).
  const accounted = new Set([
    ...result.pageData.map((p) => p.url),
    ...result.failedUrls.map((f) => f.url),
  ]);
  for (const url of Object.values(urls)) {
    assert.ok(accounted.has(url), `${url} is unaccounted for`);
  }

  const byUrl = new Map(result.failedUrls.map((f) => [f.url, f]));
  assert.equal(byUrl.size, 2, `expected exactly 2 failures, got ${[...byUrl.keys()].join(', ')}`);

  assert.deepEqual(byUrl.get(urls.missing), { url: urls.missing, reason: 'http_error', status: 404 });
  assert.deepEqual(byUrl.get(urls.empty), { url: urls.empty, reason: 'empty_after_render', status: null });

  // The two good pages were still chunked — one failure does not cost the run.
  const chunkedUrls = new Set(result.chunks.flatMap((c) => [c.url, ...(c.sourceUrls || [])]));
  assert.ok(chunkedUrls.has(urls.root), 'root page must still be chunked');
  assert.ok(chunkedUrls.has(urls.good), 'the second good page must still be chunked');

  // And neither good page is reported as lost.
  assert.ok(!byUrl.has(urls.root) && !byUrl.has(urls.good), 'a good page must never be in failedUrls');

  // skippedUrls (LEO-019, embedding failures) stays its own list and is empty here.
  assert.deepEqual(result.skippedUrls, []);
});

test('scrapeSite reports failures through the onChunks path too', async () => {
  // The route and LeoRefresh both pass onChunks, which takes a different return
  // path out of scrapeSite — the failures must survive that one as well.
  const delivered = [];
  const result = await scrapeSite(baseUrl, {
    onChunks: async (chunks) => { delivered.push(...chunks); },
  });

  assert.ok(delivered.length > 0, 'the good pages must still deliver chunks');
  assert.deepEqual(
    result.failedUrls.map((f) => f.reason).sort(),
    ['empty_after_render', 'http_error'],
  );
});

test('shapeFailedUrls normalises what the crawl collected', () => {
  const shaped = shapeFailedUrls([
    { url: 'https://d.test/a', reason: 'http_error', status: 404 },
    { url: 'https://d.test/a', reason: 'fetch_error', status: null }, // same URL twice in a run
    { url: 'https://d.test/b', reason: 'made_up' },                   // unknown reason
    { url: 'https://d.test/c', reason: 'fetch_error', status: 0 },    // 0 must not read as a status
    { reason: 'fetch_error' },                                        // no URL at all
    null,
  ]);

  assert.deepEqual(shaped, [
    { url: 'https://d.test/a', reason: 'http_error', status: 404 },
    { url: 'https://d.test/b', reason: 'fetch_error', status: null },
    { url: 'https://d.test/c', reason: 'fetch_error', status: null },
  ]);

  // Non-array input (an older crawl result, or none) shapes to nothing.
  assert.deepEqual(shapeFailedUrls(undefined), []);
  assert.deepEqual(shapeFailedUrls('nope'), []);

  // Bare strings — the skippedUrls shape — take the caller's reason.
  assert.deepEqual(shapeFailedUrls(['https://d.test/x'], 'embed_failed'), [
    { url: 'https://d.test/x', reason: 'embed_failed', status: null },
  ]);
});

// The crawl's failures must outlive the run that produced them, so "which pages
// did this scrape lose?" is answerable after the socket feed has scrolled away.
// Runs against an in-memory MongoDB, started inside the test so the offline
// crawl assertions above never wait on it.
test('recordFailedUrls persists the shaped list on the run snapshot', async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongoose = require('mongoose');
  const ScrapeSnapshot = require('../src/models/ScrapeSnapshot');
  const { recordFailedUrls } = require('../src/services/scrapePersist');

  const DOMAIN = 'failed-urls.leo-nightly.test';
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  try {
    const snapshot = await ScrapeSnapshot.create({ domain: DOMAIN, mode: 'rescrape', affectedUrls: [] });
    // A snapshot written before this field existed reads as an empty list, never undefined.
    assert.deepEqual(snapshot.failedUrls.toObject(), []);

    const shaped = await recordFailedUrls(snapshot._id, [
      { url: 'https://d.test/missing', reason: 'http_error', status: 404 },
      { url: 'https://d.test/empty', reason: 'empty_after_render', status: null },
    ]);
    assert.equal(shaped.length, 2);

    const stored = await ScrapeSnapshot.findById(snapshot._id).lean();
    assert.deepEqual(stored.failedUrls, [
      { url: 'https://d.test/missing', reason: 'http_error', status: 404 },
      { url: 'https://d.test/empty', reason: 'empty_after_render', status: null },
    ]);

    // No snapshot (a first-ever scrape has nothing to archive) and no failures are
    // both no-ops that still hand the caller a list for the summary.
    assert.deepEqual(await recordFailedUrls(null, [{ url: 'https://d.test/x', reason: 'fetch_error' }]),
      [{ url: 'https://d.test/x', reason: 'fetch_error', status: null }]);
    assert.deepEqual(await recordFailedUrls(snapshot._id, []), []);
    const untouched = await ScrapeSnapshot.findById(snapshot._id).lean();
    assert.equal(untouched.failedUrls.length, 2, 'an empty list must not wipe what was recorded');
  } finally {
    await ScrapeSnapshot.deleteMany({ domain: DOMAIN });
    await mongoose.disconnect();
    await mongod.stop();
  }
});
