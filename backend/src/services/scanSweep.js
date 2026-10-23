// LeoScan over scraped chunks — report only, never block (LEO-060).
//
// LEO-021 wired scanText() into the manual ingest path alone, and the reason it
// gave for leaving the scraper out (services/leoscan.js:1-9) was that a false
// positive during an unattended rescrape would silently drop legitimate chunks
// with nobody watching. That rules out BLOCKING, not reporting: until now a
// password or an API key on a scraped page was embedded and answerable with
// nothing anywhere saying so.
//
// Everything here is inert by construction:
//   * it runs at the two PERSISTENCE sites, after the chunks are built, and
//     returns a report. It never skips, alters, reorders or deletes a chunk —
//     services/scraper.js is not touched at all;
//   * it records RULE NAMES ONLY. scanText()'s own flags carry a redacted
//     preview, but a preview is still the first 8 characters of the match,
//     which is plenty to leak a secret into a ScrapedPage row and from there
//     into the admin log viewer. The previews are dropped here and never
//     logged, stored or returned;
//   * a throw inside the scan is swallowed per chunk, so a scan can never fail
//     a scrape that stored real chunks.
//
// Findings are keyed by URL and rewritten on every crawl, so a page that stops
// tripping clears itself on the next pass.
//
// Debug tiers — SCAN_SWEEP_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) one line per SCRAPE naming how many URLs tripped and which
//                   rules fired — never a line per chunk
//   normal          adds the sweeps that found nothing
//   verbose         adds one line per flagged URL with its rule names
// No tier ever prints the matched text. The whole point of the feature is that
// the secret is already on a public page; it has no business in the log too.

const { scanText } = require('./leoscan');

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.SCAN_SWEEP_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[ScanSweep] ${message}`);
}

// Which page URLs a chunk's flags belong to.
//
// A group chunk (multi-URL chunking for thin pages) carries the GROUP url on
// `chunk.url` and lists its member pages in `sourceUrls`. Crediting `chunk.url`
// alone would pin a flag on a synthetic group URL that may have no page row at
// all, so every member is credited — same rule as tallyChunkCounts (LEO-028).
// A single-URL chunk has `sourceUrls: [url]`, which the Set collapses.
function urlsFor(chunk) {
  return [...new Set([chunk?.url, ...(chunk?.sourceUrls || [])])].filter(Boolean);
}

/**
 * Scan a batch of built chunks and report what tripped, per URL.
 * @param {Array<{url: string, content: string, sourceUrls?: string[]}>} chunks
 * @returns {Array<{url: string, rules: string[]}>} one entry per flagged URL,
 *   rules deduped and sorted. Empty when nothing tripped. Never includes the
 *   matched text.
 */
function sweepChunks(chunks) {
  const byUrl = new Map();

  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    let rules;
    try {
      rules = [...new Set(scanText(chunk?.content).map((f) => f.rule))];
    } catch (err) {
      // A scan failure is a reporting failure, never a persistence failure.
      debug('normal', `scan failed on ${chunk?.url || 'an unknown url'} — source: ${err.message}`);
      continue;
    }
    if (rules.length === 0) continue;

    for (const url of urlsFor(chunk)) {
      if (!byUrl.has(url)) byUrl.set(url, new Set());
      const set = byUrl.get(url);
      for (const rule of rules) set.add(rule);
    }
  }

  return [...byUrl.entries()].map(([url, rules]) => ({ url, rules: [...rules].sort() }));
}

/**
 * Merge findings into an accumulator keyed by URL, as the union of their rules.
 * A full scrape sweeps batch by batch (and its thin group chunks last of all),
 * so the per-page rule list is only complete once every batch has been folded in.
 * @param {Object<string, string[]>} into
 * @param {Array<{url: string, rules: string[]}>} findings
 * @returns {Object<string, string[]>} the same accumulator, mutated
 */
function mergeSweep(into, findings) {
  for (const { url, rules } of findings || []) {
    if (!url) continue;
    into[url] = [...new Set([...(into[url] || []), ...(rules || [])])].sort();
  }
  return into;
}

/**
 * One line for the whole scrape. Called once per run, not once per batch.
 * @param {string} domain
 * @param {Object<string, string[]>} byUrl accumulated findings
 * @param {number|null} chunksScanned for the no-findings line at normal tier
 */
function logSweep(domain, byUrl, chunksScanned = null) {
  const urls = Object.keys(byUrl || {});
  const scanned = Number.isFinite(chunksScanned) ? `${chunksScanned} chunk(s)` : 'this run\'s chunks';

  if (urls.length === 0) {
    debug('normal', `${domain}: nothing tripped — source: LeoScan over ${scanned}`);
    return;
  }

  const rules = [...new Set(urls.flatMap((u) => byUrl[u] || []))].sort();
  debug(
    'light',
    `${domain}: ${urls.length} URL(s) tripped — source: LeoScan rules ${rules.join(', ')} over ${scanned} (reported only, no chunk was changed)`
  );
  for (const url of urls.sort()) debug('verbose', `  ${url} — ${(byUrl[url] || []).join(', ')}`);
}

module.exports = { sweepChunks, mergeSweep, logSweep };
