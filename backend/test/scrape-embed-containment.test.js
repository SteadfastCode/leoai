// Embedding-failure containment in the crawl loop (LEO-019).
//
// Drives the REAL scrapeSite against a local HTTP server, with the embeddings
// service stubbed to throw on its second call (the item's specified scenario:
// Voyage rethrows after MAX_RETRIES mid-crawl). Before the fix this unwound
// the whole crawl into a rejected promise; now scrapeSite must RESOLVE, keep
// the successfully-embedded batch, and report the failed batch's pages in
// skippedUrls. Puppeteer and the Haiku structural-analysis call are stubbed —
// fully offline, no browser, no network beyond 127.0.0.1.

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

let embedCalls = 0;
stubModule(require.resolve(path.join(srcDir, 'services', 'embeddings.js')), {
  embedTexts: async (texts) => {
    embedCalls += 1;
    if (embedCalls === 2) throw new Error('voyage: retries exhausted (stub)');
    return texts.map(() => [0.1, 0.2]);
  },
  embedQuery: async () => [0.1, 0.2],
});

stubModule(require.resolve(path.join(srcDir, 'services', 'claude.js')), {
  analyzePageStructure: async () => ({ exclude: [], include: [] }),
});

// scrapeSite launches a browser unconditionally; pages here are plain HTML
// with H1s so the puppeteer fallback is never taken — a close-only stand-in.
stubModule(require.resolve('puppeteer'), {
  launch: async () => ({ close: async () => {} }),
});

const { scrapeSite } = require('../src/services/scraper');

// Unique long paragraphs per page so seenParaHashes dedup never empties a page.
function page(n) {
  const filler = `Page ${n} paragraph. ` + `Unique content for page number ${n} — `.repeat(12) + 'End.';
  const links = n === 0
    ? [1, 2, 3, 4, 5, 6].map((i) => `<a href="/p${i}">p${i}</a>`).join(' ')
    : '';
  return `<html><body><h1>Page ${n} Title</h1><p>${filler}</p>${links}</body></html>`;
}

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer((req, res) => {
    const m = req.url.match(/^\/p(\d)$/);
    const n = req.url === '/' ? 0 : m ? Number(m[1]) : null;
    if (n === null) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page(n));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

test('scrapeSite resolves with skippedUrls when a batch embed fails', async () => {
  const received = [];
  // onChunks path: batch 1 is the root page alone (queue seeds with one URL),
  // batch 2 is the five linked pages — embed call 2 throws on that batch.
  const result = await scrapeSite(baseUrl, {
    onChunks: async (chunks) => { received.push(...chunks); },
  });

  assert.ok(embedCalls >= 2, `expected at least 2 embed calls, got ${embedCalls}`);
  assert.ok(Array.isArray(result.skippedUrls), 'skippedUrls must be an array');
  assert.ok(result.skippedUrls.length > 0, 'skippedUrls must be non-empty after the stubbed failure');
  assert.ok(received.length > 0, 'the successful first batch must still deliver chunks');
  // The root page embedded fine — it must not be in skippedUrls.
  assert.ok(!result.skippedUrls.includes(baseUrl.replace(/\/$/, '')) && !result.skippedUrls.includes(baseUrl),
    'successfully embedded root page must not be reported as skipped');
  // Crawl completed: all 7 pages were fetched despite the mid-crawl failure.
  assert.equal(result.pageData.length, 7);
});

// ── robots.txt: evidence with the flag off, enforcement with it on (LEO-071) ──
//
// Same harness, a second local server. These run AFTER the test above, so the
// embeddings stub's one-shot failure (embedCalls === 2) is long spent and every
// embed here succeeds — which is what lets the assertions be about chunking.
//
// The server serves a robots.txt disallowing /p1 while leaving / and /p2 alone,
// so the crawl can still start. 127.0.0.1 only; no real site is fetched.

const { resetRobotsCache, LEO_USER_AGENT } = require('../src/services/robots');

const ROBOTS_BODY = 'User-agent: *\nDisallow: /p1\n';

async function withRobotsSite(fn) {
  const requested = [];
  const srv = http.createServer((req, res) => {
    requested.push(req.url);
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(ROBOTS_BODY);
    }
    const m = req.url.match(/^\/p([12])$/);
    const n = req.url === '/' ? 0 : m ? Number(m[1]) : null;
    if (n === null) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    // Root links to both children; children are self-contained and non-thin.
    const links = n === 0 ? '<a href="/p1">p1</a> <a href="/p2">p2</a>' : '';
    const filler = `Robots page ${n}. ` + `Distinct body text for robots page number ${n} — `.repeat(12) + 'End.';
    res.end(`<html><body><h1>Robots Page ${n}</h1><p>${filler}</p>${links}</body></html>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  resetRobotsCache(); // a fresh port is a fresh origin, but be explicit
  try {
    return await fn(base, requested);
  } finally {
    await new Promise((r) => srv.close(r));
    resetRobotsCache();
  }
}

test('honorRobots off: a disallowed page is still chunked, and recorded', async () => {
  await withRobotsSite(async (base, requested) => {
    const chunked = new Set();
    const result = await scrapeSite(base, {
      crawlSettings: {}, // the default — honorRobots is absent, so false
      onChunks: async (chunks) => { for (const c of chunks) chunked.add(c.url); },
    });

    // Both pages were fetched and both produced chunks: nothing was dropped.
    assert.equal(result.pageData.length, 3, 'root + p1 + p2 all fetched');
    assert.ok(chunked.has(`${base}p1`), 'the disallowed page must still be chunked');
    assert.ok(chunked.has(`${base}p2`), 'the allowed page must be chunked');

    // And the one URL robots.txt disallowed is recorded as evidence.
    assert.deepEqual(result.robotsDisallowed, [`${base}p1`]);
    assert.ok(requested.includes('/robots.txt'), 'robots.txt was actually requested');
    assert.ok(requested.includes('/p1'), 'the disallowed page was fetched anyway');
  });
});

test('honorRobots on: the disallowed page is skipped, the other is chunked', async () => {
  await withRobotsSite(async (base, requested) => {
    const chunked = new Set();
    const result = await scrapeSite(base, {
      crawlSettings: { honorRobots: true },
      onChunks: async (chunks) => { for (const c of chunks) chunked.add(c.url); },
    });

    assert.ok(!chunked.has(`${base}p1`), 'the disallowed page must not be chunked');
    assert.ok(chunked.has(`${base}p2`), 'the allowed page must still be chunked');
    assert.ok(!result.pageData.some((p) => p.url === `${base}p1`), 'p1 never became page data');
    assert.ok(result.pageData.some((p) => p.url === `${base}p2`));

    // Still recorded — with the flag on the list says "not fetched because of this".
    assert.deepEqual(result.robotsDisallowed, [`${base}p1`]);
    // The decisive assertion: the page was never requested at all.
    assert.ok(!requested.includes('/p1'), 'the disallowed page must never be requested');
    assert.ok(requested.includes('/p2'), 'the allowed page was requested');
  });
});

test('every scraper request identifies itself as LeoAI', async () => {
  const agents = [];
  const srv = http.createServer((req, res) => {
    agents.push(req.headers['user-agent'] || '');
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('User-agent: *\nDisallow:\n');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Only Page</h1><p>' + 'Body text that is comfortably long enough. '.repeat(10) + '</p></body></html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  resetRobotsCache();
  try {
    await scrapeSite(base, { onChunks: async () => {} });
  } finally {
    await new Promise((r) => srv.close(r));
    resetRobotsCache();
  }

  assert.ok(agents.length >= 2, `expected the Pass 1, robots and page fetches, got ${agents.length}`);
  for (const ua of agents) {
    assert.equal(ua, LEO_USER_AGENT, 'no scraper request may go out unidentified');
  }
});
