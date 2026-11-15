// Puppeteer launch + navigation for the crawl's Pass 2 (LEO-146).
//
// Why this file exists. On 2026-11-14 the 21:45 UTC force rescrape of
// campcalvary.com on Railway logged 'Navigation timeout of 20000 ms exceeded'
// for EVERY Puppeteer fallback — roughly 25 pages, 21:46-21:48, all of them
// failing at exactly the 20 s mark in lockstep batches of CONCURRENCY=5. That
// crawl only looked healthy because Camp Calvary's WordPress pages survive as
// plain HTML. gbclancaster.org (Squarespace) needed Puppeteer for 87% of its
// pages, and every entity's weekly LeoRefresh runs at 03:00 UTC, so Pass 2
// being dead on Railway would quietly thin those knowledge bases.
//
// What the evidence rules out. The same pages were fetched FINE by axios in the
// same container on the same run — Pass 1 is what produced the chunks — so the
// container's network reaches the site and it is not DNS, egress or the site
// blocking us. puppeteer.launch() also clearly succeeded: a failed launch
// throws from launch, and what the logs carry is a navigation timeout, which
// only a live browser can report. Chromium starts and then cannot paint.
// Locally (Chrome 148, same code, same URLs) every one of those pages renders
// in ~3.4 s under networkidle2, so this is the Railway container, not the code
// path or the sites.
//
// What that leaves, and what this module does about it:
//
//   * /dev/shm. A container gets 64 MB of it by default; Chromium puts its
//     shared renderer memory there and renderers stall or die when it runs out.
//     --disable-dev-shm-usage (writes to /tmp instead) is the standard fix and
//     the single most likely cause here. GPU/rasteriser bring-up on a headless
//     nix Chromium is the same family of fault, hence --disable-gpu and
//     friends. These args cost nothing when they are not the cause.
//   * networkidle2 never settling. A page with analytics or a long-polling
//     socket can keep >2 connections open forever, and the old code waited for
//     idle with the whole 20 s budget. Navigation now waits for
//     domcontentloaded and then settles on the body actually having text, which
//     is what the crawl needs and cannot be held hostage by a third-party
//     beacon.
//   * A timeout is not proof that nothing rendered. The old code threw the
//     whole page away on timeout and silently fell back to plain HTML. If the
//     DOM has usable text when the clock runs out we now USE it (salvage) and
//     say so.
//   * The shared browser getting wedged under 5 concurrent renderers. Pass 2
//     page concurrency is capped (PUPPETEER_MAX_CONCURRENCY, default 3) so a
//     constrained container is never asked for five renderers at once. Pass 1
//     stays at CONCURRENCY=5 — only rendering is throttled.
//
// Nothing here may fail a crawl. Every failure path ends in the caller's plain
// HTML result with one clear line per page saying so, and the per-crawl summary
// (puppeteerSummary) reports how many pages needed rendering and how many could
// not be rendered, so a repeat of 2026-11-14 is visible in the Crawls view
// instead of hiding behind a healthy-looking chunk count.
//
// Debug tiers — PUPPETEER_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) browser launch (version, binary, args — the SOURCE of the
//                   config), every salvage, every failure, per-crawl summary
//   normal          adds one line per rendered page with its navigation timing
//   verbose         adds settle-wait outcomes and render-slot queueing
//
// Unit-tested in backend/test/puppeteer-nav.test.js.

const puppeteer = require('puppeteer');

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function logTier() {
  const name = String(process.env.PUPPETEER_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[Puppeteer] ${message}`);
}

// Read an integer env var, falling back to `def` on anything unparseable, and
// clamp it so a typo cannot park a crawl for an hour or set a 0 ms timeout.
function envInt(name, def, min, max) {
  const n = parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const navTimeoutMs  = () => envInt('PUPPETEER_NAV_TIMEOUT_MS', 25000, 5000, 60000);
const settleMs      = () => envInt('PUPPETEER_SETTLE_MS', 3000, 0, 15000);
const maxConcurrent = () => envInt('PUPPETEER_MAX_CONCURRENCY', 3, 1, 10);

// Enough text that the page said something. Matches the old post-networkidle2
// intent ("body.innerText > 100 chars") rather than inventing a new bar.
const SETTLE_MIN_CHARS = 100;
// Settle polling: the text length has to repeat this many times in a row before
// the page counts as done growing.
const SETTLE_POLL_MS = 200;
const SETTLE_STABLE_POLLS = 2;
// A salvaged timeout has to be worth more than the plain-HTML result it would
// replace; below this the page really did not render and we say it failed.
const SALVAGE_MIN_CHARS = 200;
const MAX_RECORDED_FAILURES = 20;

// Chromium flags for a headless container. --no-sandbox/--disable-setuid-sandbox
// are the two the crawl always passed; the rest are the LEO-146 additions.
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--mute-audio',
];

// Per-browser Pass 2 tally. A WeakMap so a closed browser's stats stay readable
// for the summary the crawl returns after browser.close(), without pinning it.
const stats = new WeakMap();
// Per-browser render-slot semaphore, keyed the same way.
const slots = new WeakMap();

function statsFor(browser) {
  if (!browser) return { attempted: 0, rendered: 0, salvaged: 0, failed: 0, failures: [] };
  if (!stats.has(browser)) {
    stats.set(browser, { attempted: 0, rendered: 0, salvaged: 0, failed: 0, failures: [] });
  }
  return stats.get(browser);
}

function recordFailure(browser, url, reason) {
  const s = statsFor(browser);
  s.failed++;
  if (s.failures.length < MAX_RECORDED_FAILURES) s.failures.push({ url, reason });
}

// Pass 2 summary for one crawl: how many pages needed rendering, how many were
// rendered, how many fell back to plain HTML. Safe to call after browser.close().
// Pass `label` (the crawl's domain) to also log the one-line summary — that keeps
// the reporting here rather than spending restricted scraper.js lines on it.
function puppeteerSummary(browser, label) {
  const s = statsFor(browser);
  if (label && s.attempted) debug('light', `${label}: ${summaryLine(s)}`);
  return {
    attempted: s.attempted,
    rendered:  s.rendered,
    salvaged:  s.salvaged,
    failed:    s.failed,
    failures:  s.failures.slice(),
  };
}

function summaryLine(summary) {
  return `${summary.attempted} pages needed JS rendering — ${summary.rendered} rendered`
    + `${summary.salvaged ? ` (${summary.salvaged} salvaged after a nav timeout)` : ''}`
    + `, ${summary.failed} fell back to plain HTML`;
}

async function launchBrowser() {
  const t0 = Date.now();
  const browser = await puppeteer.launch({
    headless: true,
    args: LAUNCH_ARGS,
    // Default is 180 s; a wedged CDP call must not outlive the whole crawl.
    protocolTimeout: 60000,
  });
  statsFor(browser);
  let version = 'unknown';
  try { version = await browser.version(); } catch { /* reported as unknown */ }
  debug('light', `launched ${version} in ${Date.now() - t0}ms `
    + `(binary: ${process.env.PUPPETEER_EXECUTABLE_PATH || 'puppeteer bundled Chrome'}, `
    + `source: PUPPETEER_EXECUTABLE_PATH ${process.env.PUPPETEER_EXECUTABLE_PATH ? 'set' : 'unset'}; `
    + `nav timeout ${navTimeoutMs()}ms, settle ${settleMs()}ms, render slots ${maxConcurrent()})`);
  return browser;
}

// Open a page, waiting for a render slot first so Pass 2 never runs more
// renderers at once than maxConcurrent(). Released by releasePage().
async function acquirePage(browser) {
  if (!slots.has(browser)) slots.set(browser, { active: 0, waiting: [] });
  const slot = slots.get(browser);
  if (slot.active >= maxConcurrent()) {
    debug('verbose', `render slots full (${slot.active}/${maxConcurrent()}) — queueing, ${slot.waiting.length} already waiting`);
    await new Promise(resolve => slot.waiting.push(resolve));
  }
  slot.active++;
  try {
    return await browser.newPage();
  } catch (err) {
    releaseSlot(browser);
    throw err;
  }
}

function releaseSlot(browser) {
  const slot = slots.get(browser);
  if (!slot) return;
  slot.active = Math.max(0, slot.active - 1);
  const next = slot.waiting.shift();
  if (next) next();
}

async function releasePage(page, browser) {
  try {
    await page.close();
  } catch (err) {
    debug('light', `page.close() failed: ${err.message} (source: releasePage; slot released anyway)`);
  } finally {
    releaseSlot(browser || page.browser?.());
  }
}

// Wait for the page to have STOPPED growing, capped at settleMs.
//
// Waiting only for "body has some text" is not enough and was measured to lose
// content: gbclancaster.org (Squarespace) reaches 100 chars almost immediately
// and 598 chars about a second later, so a first-text-wins settle read 362
// chars where networkidle2 read 598. Polling until the length repeats gets the
// late content without ever waiting on a third-party beacon. A thin page that
// never reaches SETTLE_MIN_CHARS is not an error — it just gets the full cap.
async function settleForText(page, url) {
  const t0 = Date.now();
  const budget = settleMs();
  if (budget === 0) return;
  let last = -1;
  let stable = 0;
  while (Date.now() - t0 < budget) {
    const len = await bodyTextLength(page);
    if (len > SETTLE_MIN_CHARS && len === last) {
      if (++stable >= SETTLE_STABLE_POLLS) {
        debug('verbose', `${url} — text stable at ${len} chars after ${Date.now() - t0}ms of settle`);
        return;
      }
    } else {
      stable = 0;
    }
    last = len;
    await sleep(SETTLE_POLL_MS);
  }
  debug('verbose', `${url} — still growing (or still thin) at ${last} chars when the ${budget}ms settle ran out`);
}

async function bodyTextLength(page) {
  try {
    return await page.evaluate(() => (document.body?.innerText || '').length);
  } catch {
    return 0;
  }
}

// Navigate `page` to `url` for Pass 2. Resolves when the page is ready to be
// read, including the salvage case; throws only when nothing usable rendered,
// which the caller turns into its plain-HTML fallback.
async function navigate(page, url, opts = {}) {
  const { browser } = opts;
  const s = statsFor(browser);
  s.attempted++;
  const timeout = navTimeoutMs();
  const t0 = Date.now();

  let timedOut = null;
  try {
    // domcontentloaded, NOT networkidle2: a third-party beacon or a long-poll
    // keeps the network busy forever and used to eat the entire budget.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (err) {
    timedOut = err.message.split('\n')[0];
  }

  await settleForText(page, url);
  const chars = await bodyTextLength(page);
  const ms = Date.now() - t0;

  if (!timedOut) {
    s.rendered++;
    debug('normal', `${url} — rendered ${chars} chars in ${ms}ms (source: domcontentloaded + settle)`);
    return { ms, chars, salvaged: false };
  }

  if (chars >= SALVAGE_MIN_CHARS) {
    s.rendered++;
    s.salvaged++;
    debug('light', `${url} — navigation timed out after ${ms}ms but the DOM rendered ${chars} chars, using it (source: post-timeout document.body check, not the goto result)`);
    return { ms, chars, salvaged: true };
  }

  throw new Error(`${timedOut} — ${chars} chars rendered after ${ms}ms, nothing to salvage`);
}

// One clear line per page whose render failed, saying what was used instead.
function noteFallback(browser, url, err, plainTextLength) {
  const reason = (err && err.message ? err.message : String(err)).split('\n')[0];
  recordFailure(browser, url, reason);
  console.warn(`[Puppeteer] ${url} — render failed (${reason}); used the plain-HTML result instead (${plainTextLength} chars)`);
}

// Superadmin diagnostic (GET /api/admin/puppeteer-check). Launches a browser,
// loads each URL under both wait strategies and reports timings, so whether
// Pass 2 works on Railway is a measurement rather than a guess. Never scrapes:
// one page load per URL per strategy, text length only.
async function diagnose(urls, opts = {}) {
  const timeout = Math.min(60000, Math.max(2000, opts.timeoutMs || navTimeoutMs()));
  const strategies = opts.waitUntil ? [opts.waitUntil] : ['domcontentloaded', 'networkidle2'];
  const out = {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    args: LAUNCH_ARGS,
    navTimeoutMs: timeout,
    settleMs: settleMs(),
    maxConcurrency: maxConcurrent(),
    launchMs: null,
    version: null,
    launchError: null,
    results: [],
  };

  const t0 = Date.now();
  let browser;
  try {
    browser = await launchBrowser();
    out.launchMs = Date.now() - t0;
    out.version = await browser.version().catch(() => 'unknown');
  } catch (err) {
    out.launchMs = Date.now() - t0;
    out.launchError = err.message.split('\n')[0];
    return out;
  }

  try {
    for (const url of urls) {
      for (const waitUntil of strategies) {
        const page = await browser.newPage();
        const t = Date.now();
        const row = { url, waitUntil, ms: null, chars: 0, ok: false, error: null };
        try {
          await page.goto(url, { waitUntil, timeout });
          row.ok = true;
        } catch (err) {
          row.error = err.message.split('\n')[0];
        }
        row.chars = await bodyTextLength(page);
        row.ms = Date.now() - t;
        out.results.push(row);
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return out;
}

module.exports = {
  launchBrowser,
  acquirePage,
  releasePage,
  navigate,
  noteFallback,
  puppeteerSummary,
  summaryLine,
  diagnose,
  LAUNCH_ARGS,
  // test seams
  _internals: { statsFor, settleForText, bodyTextLength, envInt, sleep },
};
