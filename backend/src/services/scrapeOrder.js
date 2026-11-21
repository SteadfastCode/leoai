// Deterministic crawl order (LEO-138).
//
// From the 2026-11-14 scrape audit. Pages are fetched CONCURRENCY at a time with
// Promise.all, and every result was pushed onto the run's lists from inside the
// per-page callback — so the order of those lists was the order the fetches
// happened to finish in. Nothing downstream is order-independent:
//
//   * paragraph dedup (seenParaHashes) keeps the FIRST page a short paragraph
//     appears on and drops it everywhere after, so which page owns the opening
//     hours, the address or the phone number changed between two runs of the
//     same unchanged site;
//   * chunk-level dedup (seenChunkHashes) keeps the first identical chunk;
//   * thin pages are packed into group chunks in list order, so the cards inside
//     a group chunk — and therefore the chunk's text and its hash — moved;
//   * links are discovered per page, so the crawl queue, and with it which pages
//     fall inside the MAX_PAGES cap, followed the same coin flip.
//
// The consequence was not a cosmetic one: a rescrape diffs the page's text hash,
// so a page whose paragraph was taken by a different owner this run reads as
// CHANGED and is re-embedded, and the page that lost it reads as changed too.
// Two runs against a site nobody touched could churn a third of the corpus, and
// any measurement of a retrieval change (LEO-139, LEO-141, LEO-142 all wait on
// this) was measuring the coin flip as much as the change.
//
// So: one order, the canonical URL's, applied at the two points where the
// completion order used to leak in. services/scraper.js is restricted to small
// diffs, so the logic lives here and the crawl only calls it.
//
// Debug tiers — SCRAPE_ORDER_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) one line per batch whose order the sort actually changed,
//                   naming the first URL before and after — the SOURCE of the
//                   reordering, not just that it happened
//   normal          adds one line per batch that was already in order, and the
//                   per-flush link counts
//   verbose         adds the full ordered URL list of every batch
// Reordering is invisible in the result — the same pages, a different owner for
// a deduped paragraph — so even the light tier names what moved.

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.SCRAPE_ORDER_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[ScrapeOrder] ${message}`);
}

// Plain codepoint comparison, never localeCompare: the order has to be identical
// on Daniel's laptop, in CI and on Railway, and locale collation is none of those
// things. Ties fall back to insertion order, so the sort is stable for two
// entries that really do carry the same URL.
function compareUrls(a, b) {
  const x = String(a?.url ?? '');
  const y = String(b?.url ?? '');
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

/**
 * Sort a batch of fetched pages into canonical URL order, IN PLACE.
 *
 * In place on purpose: the crawl pushes the same objects onto its own lists and
 * hands the same array to embedPageData, so returning a copy would leave the
 * caller free to use the unsorted one by accident. Returns the array too, for
 * callers that want to read it in one expression.
 *
 * @param {Array<{url: string}>} pages fetched page entries
 * @returns {Array<{url: string}>} the same array, sorted
 */
function orderPages(pages) {
  if (!Array.isArray(pages) || pages.length < 2) return pages || [];
  const firstBefore = pages[0]?.url;
  pages.sort(compareUrls);
  const firstAfter = pages[0]?.url;
  if (firstBefore !== firstAfter) {
    debug('light', `reordered ${pages.length} pages — source: fetch-completion order started at ${firstBefore}, canonical order starts at ${firstAfter}`);
  } else {
    debug('normal', `${pages.length} pages already in canonical order from ${firstAfter}`);
  }
  debug('verbose', `  order: ${pages.map((p) => p.url).join(', ')}`);
  return pages;
}

/**
 * A crawl queue whose link discovery does not depend on fetch completion order.
 *
 * The crawl resolves a page's links inside its own concurrent callback, and each
 * callback pushes its whole block of links in one synchronous pass — so the
 * queue was a concatenation of per-page blocks ordered by whichever fetch
 * returned first. note() buffers instead; flush(), called once the batch has
 * settled, replays the buffer with the blocks ordered by the page they came
 * from. Within one page, document order is preserved.
 *
 * The push/unshift split is the crawl's own and is kept exactly: a link to a
 * subdomain goes to the FRONT so shop pages are not crowded out by main-site
 * pagination (see CLAUDE.md).
 *
 * @param {string[]} queue the crawl's queue array, mutated in place
 */
function makeLinkQueue(queue) {
  let pending = [];
  return {
    /**
     * @param {string} url      the resolved, canonical link target
     * @param {string} fromUrl  the page it was found on — the sort key
     * @param {boolean} subdomain true to send it to the front of the queue
     */
    note(url, fromUrl, subdomain) {
      pending.push({ url, fromUrl: String(fromUrl ?? ''), subdomain: !!subdomain, i: pending.length });
    },
    flush() {
      if (pending.length === 0) return 0;
      const count = pending.length;
      pending.sort((a, b) => {
        if (a.fromUrl < b.fromUrl) return -1;
        if (a.fromUrl > b.fromUrl) return 1;
        return a.i - b.i;
      });
      let subs = 0;
      for (const link of pending) {
        if (link.subdomain) { queue.unshift(link.url); subs++; }
        else queue.push(link.url);
      }
      debug('normal', `queued ${count} link(s) in canonical page order (${subs} subdomain link(s) to the front) — source: this batch's pages, sorted by the page they were found on`);
      for (const link of pending) debug('verbose', `  ${link.fromUrl} → ${link.url}`);
      pending = [];
      return count;
    },
  };
}

module.exports = { orderPages, makeLinkQueue, compareUrls };
