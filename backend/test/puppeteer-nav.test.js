// Pass 2 navigation and the plain-HTML fallback (LEO-146).
//
// The bug this guards: on Railway every Puppeteer navigation timed out at
// 20 000 ms, fetchPage swallowed the error with a console.warn, and the crawl
// reported success because the sites' plain HTML happened to be good enough.
// Nothing in the result or the dashboard said Pass 2 was dead.
//
// Fully offline — no browser, no network except 127.0.0.1, no database. The
// browser/page objects here are fakes that reproduce the three shapes that
// matter: a clean navigation, a navigation that times out having rendered
// usable text anyway (salvage), and one that times out with an empty DOM.

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

// puppeteerNav requires puppeteer at load time, so the stub has to be in place
// BEFORE it is required — otherwise launchBrowser() starts a real Chromium and
// the end-to-end test below silently measures the real browser instead of the
// wedged one it means to reproduce.
let launchImpl = async () => { throw new Error('no launch stub installed'); };
stubModule(require.resolve('puppeteer'), { launch: (...a) => launchImpl(...a) });

const nav = require('../src/services/puppeteerNav');
const { navigate, noteFallback, puppeteerSummary, acquirePage, releasePage, LAUNCH_ARGS } = nav;

// Keep the suite fast and deterministic: no settle wait, short nav timeout.
process.env.PUPPETEER_SETTLE_MS = '0';
process.env.PUPPETEER_NAV_TIMEOUT_MS = '5000';
process.env.PUPPETEER_LOG_LEVEL = 'off';

// A fake page. `bodyText` is what document.body.innerText would return, and
// `gotoError` makes goto reject the way a real navigation timeout does.
function fakePage({ bodyText = '', gotoError = null } = {}) {
  const page = {
    closed: false,
    async setUserAgent() {},
    async goto() { if (gotoError) throw new Error(gotoError); },
    async waitForFunction() { if (bodyText.length <= 100) throw new Error('waitForFunction timeout'); },
    async evaluate(fn) { return fn(); },
    async close() { page.closed = true; },
  };
  // navigate()/bodyTextLength read document.body.innerText through page.evaluate,
  // so give the evaluated function a document to see.
  page.evaluate = async (fn, ...args) => {
    global.document = { body: { innerText: bodyText } };
    try { return fn(...args); } finally { delete global.document; }
  };
  return page;
}

function fakeBrowser(pageOpts = {}) {
  const browser = {
    pages: [],
    async newPage() { const p = fakePage(pageOpts); browser.pages.push(p); return p; },
    async close() {},
  };
  return browser;
}

const TIMEOUT_MSG = 'Navigation timeout of 20000 ms exceeded';

test('container-safe Chromium flags are passed at launch', () => {
  // --disable-dev-shm-usage is the whole point: a container's 64 MB /dev/shm is
  // the prime suspect for the 2026-11-14 all-pages timeout.
  assert.ok(LAUNCH_ARGS.includes('--disable-dev-shm-usage'));
  assert.ok(LAUNCH_ARGS.includes('--no-sandbox'));
  assert.ok(LAUNCH_ARGS.includes('--disable-setuid-sandbox'));
  assert.ok(LAUNCH_ARGS.includes('--disable-gpu'));
});

test('a clean navigation counts as rendered', async () => {
  const browser = fakeBrowser();
  const page = fakePage({ bodyText: 'x'.repeat(900) });
  const out = await navigate(page, 'https://example.com/a', { browser });
  assert.equal(out.salvaged, false);
  assert.equal(out.chars, 900);
  const s = puppeteerSummary(browser);
  assert.deepEqual([s.attempted, s.rendered, s.salvaged, s.failed], [1, 1, 0, 0]);
});

test('a timed-out navigation that rendered usable text is salvaged, not discarded', async () => {
  const browser = fakeBrowser();
  const page = fakePage({ bodyText: 'y'.repeat(600), gotoError: TIMEOUT_MSG });
  const out = await navigate(page, 'https://example.com/slow', { browser });
  assert.equal(out.salvaged, true);
  assert.equal(out.chars, 600);
  const s = puppeteerSummary(browser);
  assert.deepEqual([s.attempted, s.rendered, s.salvaged, s.failed], [1, 1, 1, 0]);
});

test('a timed-out navigation with an empty DOM throws and is recorded as a failure', async () => {
  const browser = fakeBrowser();
  const page = fakePage({ bodyText: '', gotoError: TIMEOUT_MSG });
  await assert.rejects(
    () => navigate(page, 'https://example.com/dead', { browser }),
    /Navigation timeout of 20000 ms exceeded.*nothing to salvage/s,
  );
  // The caller is what records the fallback, exactly as fetchPage does.
  noteFallback(browser, 'https://example.com/dead', new Error(TIMEOUT_MSG), 1234);
  const s = puppeteerSummary(browser);
  assert.equal(s.attempted, 1);
  assert.equal(s.rendered, 0);
  assert.equal(s.failed, 1);
  assert.deepEqual(s.failures, [{ url: 'https://example.com/dead', reason: TIMEOUT_MSG }]);
});

test('text just under the salvage floor is a failure, not a salvage', async () => {
  const browser = fakeBrowser();
  const page = fakePage({ bodyText: 'z'.repeat(150), gotoError: TIMEOUT_MSG });
  await assert.rejects(() => navigate(page, 'https://example.com/thin', { browser }), /nothing to salvage/);
  assert.equal(puppeteerSummary(browser).rendered, 0);
});

test('render slots cap concurrent pages and are released on close', async () => {
  process.env.PUPPETEER_MAX_CONCURRENCY = '2';
  const browser = fakeBrowser({ bodyText: 'ok'.repeat(200) });
  let live = 0;
  let peak = 0;
  await Promise.all([1, 2, 3, 4, 5].map(async () => {
    const page = await acquirePage(browser);
    live++;
    peak = Math.max(peak, live);
    await new Promise(r => setTimeout(r, 10));
    live--;
    await releasePage(page, browser);
  }));
  assert.equal(peak, 2, `expected at most 2 concurrent pages, saw ${peak}`);
  assert.equal(browser.pages.length, 5);
  assert.ok(browser.pages.every(p => p.closed));
  delete process.env.PUPPETEER_MAX_CONCURRENCY;
});

test('a render slot is not leaked when newPage itself fails', async () => {
  process.env.PUPPETEER_MAX_CONCURRENCY = '1';
  const browser = { async newPage() { throw new Error('Target closed'); }, async close() {} };
  await assert.rejects(() => acquirePage(browser), /Target closed/);
  // The slot must be free, or this second call would hang forever.
  await assert.rejects(() => acquirePage(browser), /Target closed/);
  delete process.env.PUPPETEER_MAX_CONCURRENCY;
});

test('the summary is empty, not null, for a crawl that never needed Pass 2', () => {
  const s = puppeteerSummary({ never: 'used' });
  assert.deepEqual(s, { attempted: 0, rendered: 0, salvaged: 0, failed: 0, failures: [] });
});

test('env overrides are clamped rather than trusted', () => {
  const { envInt } = nav._internals;
  process.env.LEO_TEST_INT = '999999';
  assert.equal(envInt('LEO_TEST_INT', 25000, 5000, 60000), 60000);
  process.env.LEO_TEST_INT = '1';
  assert.equal(envInt('LEO_TEST_INT', 25000, 5000, 60000), 5000);
  process.env.LEO_TEST_INT = 'not a number';
  assert.equal(envInt('LEO_TEST_INT', 25000, 5000, 60000), 25000);
  delete process.env.LEO_TEST_INT;
});

// ---------------------------------------------------------------------------
// The real crawl, end to end: a page with no H1 triggers Pass 2, Pass 2 fails,
// and the run must still succeed AND say so in its result. This is the shape
// that reported a clean success on 2026-11-14.
// ---------------------------------------------------------------------------

test('a crawl whose Pass 2 fails still succeeds and reports it in the result', async () => {
  const filler = 'Hours and directions. ' + 'Plain HTML content that cheerio reads fine — '.repeat(12) + 'End.';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    // No <h1> anywhere, so needsPuppeteer is true for both pages.
    res.end(`<html><body><p>${filler} ${req.url}</p><a href="/two">two</a></body></html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;

  // A browser whose pages always time out with an empty DOM — production on
  // 2026-11-14, reduced.
  launchImpl = async () => ({
    async version() { return 'HeadlessChrome/stub'; },
    async newPage() { return fakePage({ bodyText: '', gotoError: TIMEOUT_MSG }); },
    async close() {},
  });
  delete require.cache[require.resolve('../src/services/scraper')];
  const { scrapeSite } = require('../src/services/scraper');

  try {
    const result = await scrapeSite(baseUrl, { domain: 'pass2.test' });
    assert.ok(result.puppeteer, 'result carries a Pass 2 summary');
    assert.ok(result.puppeteer.attempted >= 1, 'Pass 2 was attempted');
    assert.equal(result.puppeteer.rendered, 0);
    assert.equal(result.puppeteer.failed, result.puppeteer.attempted);
    assert.ok(result.puppeteer.failures.length >= 1);
    assert.match(result.puppeteer.failures[0].reason, /Navigation timeout|nothing to salvage/);
    // The plain-HTML text is still what got chunked — the crawl is not lost.
    assert.ok(result.chunks.length >= 1, 'plain-HTML chunks were still produced');
  } finally {
    await new Promise(r => server.close(r));
  }
});
