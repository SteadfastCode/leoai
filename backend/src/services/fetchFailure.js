// Fetch-failure classification for the crawl loop (LEO-056).
//
// A page that 404s, times out, or comes back empty after the Puppeteer fallback
// used to be dropped with a console warning and nothing else: no ScrapedPage row
// was written, so the owner was told "534 pages" with no way to learn which URLs
// Leo never read. scraper.js is a restricted file (≤30 changed lines), so it only
// pushes the entries this module builds; the shaping the owner sees happens in
// scrapePersist.js. Same split as embedGuard.js, which contains the OTHER way a
// URL is lost in a run — a page that fetched fine but failed to embed (LEO-019).
//
// Debug tiers — SCRAPE_FAILURE_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing (the crawl's own "Skipping <url>" warning still prints)
//   light (default) one line per lost URL, naming the reason that classified it
//   normal          adds the error message behind a fetch_error
//   verbose         adds the error's own code/name, for a transport failure that
//                   reads the same from the outside (DNS vs. TLS vs. timeout)
// A lost page is invisible in the result — a smaller chunk count and nothing
// else — so even the light tier names the SOURCE of the classification.

const REASONS = ['fetch_error', 'http_error', 'empty_after_render'];

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.SCRAPE_FAILURE_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[ScrapeFailure] ${message}`);
}

// Classify a thrown fetch error. An axios error carries the response for a 404 or
// a 500; anything else (timeout, DNS, TLS, binary body, non-HTML content type) has
// no status and is a fetch_error.
function classifyFetchFailure(url, err) {
  const raw = Number(err?.response?.status);
  const status = Number.isFinite(raw) && raw > 0 ? raw : null;
  const reason = status ? 'http_error' : 'fetch_error';

  debug('light', `not learned: ${url} — source: ${reason}${status ? ` (HTTP ${status})` : ''}`);
  if (!status) debug('normal', `  ${url} — fetch error message: ${err?.message || 'unknown'}`);
  debug('verbose', `  ${url} — error code ${err?.code || 'none'}, name ${err?.name || 'none'}`);

  return { url, reason, status };
}

// A page that fetched with a 200 but produced no text at all. The Puppeteer
// fallback has already been tried by then (an empty body has no H1, which is
// itself the fallback trigger), so this is the end of the line for the URL.
function noteEmptyAfterRender(url) {
  debug('light', `not learned: ${url} — source: empty_after_render (0 chars extracted)`);
  return { url, reason: 'empty_after_render', status: null };
}

module.exports = { classifyFetchFailure, noteEmptyAfterRender, REASONS };
