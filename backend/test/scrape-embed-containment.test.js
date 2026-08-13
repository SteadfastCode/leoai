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
