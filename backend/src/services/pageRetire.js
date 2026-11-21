// Dead-page retirement (LEO-138).
//
// From the 2026-11-14 scrape audit. A rescrape only ever added or replaced: it
// rewrote the chunks of the pages it reached and left every other stored page
// exactly as it was. A page DELETED from the site is therefore never reached
// again, so its chunks live on and keep being retrieved — the April Holy Week
// page on gbclancaster.org was still answering questions in November. The only
// thing that ever cleared them was a full or forced scrape, which wipes the
// whole corpus and re-embeds it.
//
// The rules, in the order they are applied per stored page:
//
//   1. A 404 or 410 retires the page AT ONCE. The site has been asked and has
//      said the page is gone; waiting two more nights only keeps a wrong answer
//      alive longer.
//   2. Any OTHER fetch failure — timeout, DNS, TLS, a 500, empty-after-render —
//      RESETS the counter. A page that is merely unreachable tonight must never
//      be deleted for it; that is the difference between "gone" and "down", and
//      getting it wrong destroys content that is still live.
//   3. A page the crawl reached resets the counter.
//   4. A page the crawl never reached at all takes one miss, and is retired on
//      the MAX_MISSES'th consecutive one. Two crawls, because a single run can
//      miss a page for reasons that have nothing to do with the page: the one
//      link to it was inside a nav block a Pass 1 filter removed, or its linking
//      page timed out.
//
// Owner-authored chunks are never touched — the delete carries the same
// `source: { $nin: PRESERVED_SOURCES }` filter every other destructive path in
// the codebase carries, so a manual chunk, an upload, an owner reply or an
// unanswered_qa answer filed against a dead URL survives it.
//
// Three guards, because this is the only code in the repo that deletes chunks
// nobody asked it to delete, and a bad crawl must not take the corpus with it:
//
//   * the crawl hit the MAX_PAGES cap — it did not fail to reach the pages past
//     the cap, it never looked at them;
//   * the crawl reached less than MIN_REACH_RATIO of the stored pages — the site
//     was down, the nav changed, or robots started disallowing the crawl;
//   * the run wants to retire more than a third of the stored pages (floored at
//     MIN_RETIRE_FLOOR, so a three-page site can still lose one) — which is what
//     a server answering 404 to everything looks like from in here, and rule 1
//     would otherwise delete the whole corpus in a single run.
//
// A tripped guard retires NOTHING and logs why. The counters are left alone too:
// a bad night must not spend a page's grace.
//
// Everything destructive still happens after the run's ScrapeSnapshot, so a
// retirement is restorable like any other scrape mutation — see scrapePersist.
//
// Debug tiers — PAGE_RETIRE_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) one line per run naming what was retired and the RULE that
//                   retired it, and one line naming any guard that tripped
//   normal          adds the reach figures the decision was taken on
//   verbose         adds one line per page, including the ones merely bumped
// A retired page is invisible afterwards — the row and the chunks are gone — so
// even the light tier names the source of the decision.

const Chunk = require('../models/Chunk');
const ScrapedPage = require('../models/ScrapedPage');
const { MAX_PAGES } = require('./crawlLimits');

const { PRESERVED_SOURCES } = Chunk;

// Consecutive crawls that must miss a page before it is retired.
const MAX_MISSES = 2;
// Share of the stored pages a crawl must have reached for its verdict to count.
const MIN_REACH_RATIO = 0.5;
// Share of the stored pages a single run may retire, and the absolute number it
// may always retire regardless of the share.
const MAX_RETIRE_RATIO = 1 / 3;
const MIN_RETIRE_FLOOR = 3;
// HTTP statuses that mean "this page is gone", not "this page is unwell".
const GONE_STATUSES = new Set([404, 410]);

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.PAGE_RETIRE_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[PageRetire] ${message}`);
}

// Mirrors urlKey() in scraper.js: hostname + pathname. Deliberately NOT an exact
// string match. LEO-137 made every newly stored URL canonical, but rows written
// before it still carry whatever spelling was queued first — http for https, www
// for bare — and those are the same page the crawl just read, not a dead one.
// Matching on the crawl's own dedup key is what makes "the crawl did not reach
// this page" mean the page, rather than a spelling of it.
function pageKey(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.hostname + u.pathname;
  } catch {
    return String(urlStr ?? '');
  }
}

function urlOf(entry) {
  return typeof entry === 'string' ? entry : entry?.url;
}

// Every page key this run can show evidence of having looked at.
//
// Wider than "produced a chunk" on purpose, and every list is a separate kind of
// evidence: a page can be unchanged (no chunk written), embed-skipped (LEO-019),
// a thin page folded into a group chunk and named only in its sourceUrls, a
// synthetic group URL that is not a page at all, or robots-disallowed. Each of
// those was reached. Only a page in none of them was not.
function reachedKeys(result = {}) {
  const reached = new Set();
  const add = (u) => { if (u) reached.add(pageKey(u)); };

  for (const p of result.pageHashUpdates || []) add(urlOf(p));
  for (const u of result.unchangedUrls || []) add(urlOf(u));
  for (const u of result.changedUrls || []) add(urlOf(u));
  for (const u of result.skippedUrls || []) add(urlOf(u));
  for (const u of result.thinGroupUrls || []) add(urlOf(u));
  for (const u of result.robotsDisallowed || []) add(urlOf(u));
  for (const f of result.failedUrls || []) add(urlOf(f));
  // A thin page is credited only inside the group chunk it was packed into, so
  // its own URL appears nowhere else in the result.
  for (const c of [...(result.embeddedChunks || []), ...(result.thinGroupChunks || [])]) {
    add(c?.url);
    for (const u of c?.sourceUrls || []) add(u);
  }
  return reached;
}

// Page keys the site actively reported gone this run.
function goneKeys(result = {}) {
  const gone = new Set();
  for (const f of result.failedUrls || []) {
    const url = urlOf(f);
    if (!url) continue;
    const status = Number(typeof f === 'string' ? NaN : f?.status);
    if (GONE_STATUSES.has(status)) gone.add(pageKey(url));
  }
  return gone;
}

/**
 * Decide what this run retires, purely — no database, no mutation.
 *
 * @param {object} args
 * @param {Array<{url: string, missedCrawls?: number}>} args.storedPages rows for the domain,
 *   read BEFORE the run's own writes
 * @param {object} args.result a rescrapeSite() result
 * @param {string} [args.domain] for log lines only
 * @returns {{retire: Array<{url: string, misses: number, reason: string}>, bump: string[],
 *   reset: string[], skipped: string|null}}
 */
function planRetirement({ storedPages = [], result = {}, domain = '' } = {}) {
  const plan = { retire: [], bump: [], reset: [], skipped: null };
  const pages = Array.isArray(storedPages) ? storedPages.filter((p) => p && p.url) : [];
  if (pages.length === 0) return plan;

  const reached = reachedKeys(result);
  const gone = goneKeys(result);
  const seenStored = pages.filter((p) => reached.has(pageKey(p.url))).length;
  const ratio = seenStored / pages.length;
  const where = domain || 'this domain';

  const stop = (why) => {
    plan.skipped = why;
    plan.retire = [];
    plan.bump = [];
    plan.reset = [];
    debug('light', `${where}: retired nothing — source: ${why}`);
    return plan;
  };

  debug('normal', `${where}: crawl reached ${reached.size} page key(s), ${seenStored} of ${pages.length} stored (${Math.round(ratio * 100)}%), ${gone.size} reported gone`);

  if (reached.size >= MAX_PAGES) {
    return stop(`the crawl reached the ${MAX_PAGES}-page cap, so the pages past it were never looked at`);
  }
  if (ratio < MIN_REACH_RATIO) {
    return stop(`the crawl reached ${seenStored} of ${pages.length} stored pages, under the ${Math.round(MIN_REACH_RATIO * 100)}% floor`);
  }

  for (const page of pages) {
    const key = pageKey(page.url);
    const misses = Number(page.missedCrawls) || 0;
    if (gone.has(key)) {
      plan.retire.push({ url: page.url, misses, reason: 'gone' });
      continue;
    }
    if (reached.has(key)) {
      if (misses > 0) plan.reset.push(page.url);
      continue;
    }
    const next = misses + 1;
    if (next >= MAX_MISSES) plan.retire.push({ url: page.url, misses: next, reason: 'unreached' });
    else plan.bump.push(page.url);
  }

  const allowance = Math.max(MIN_RETIRE_FLOOR, Math.floor(pages.length * MAX_RETIRE_RATIO));
  if (plan.retire.length > allowance) {
    return stop(`the run wanted to retire ${plan.retire.length} of ${pages.length} stored pages, over the ${allowance}-page allowance`);
  }

  for (const r of plan.retire) {
    debug('light', `${where}: retiring ${r.url} — source: ${r.reason === 'gone' ? 'the site answered 404/410 for it' : `${r.misses} consecutive crawls did not reach it`}`);
  }
  for (const url of plan.bump) debug('verbose', `  ${where}: ${url} missed this crawl, not yet at ${MAX_MISSES}`);
  for (const url of plan.reset) debug('verbose', `  ${where}: ${url} reached again, miss counter cleared`);

  return plan;
}

/**
 * Apply a plan. Deletes the retired pages' scraped chunks and their rows, and
 * moves the miss counters.
 *
 * Called AFTER the run's snapshot, which archives the chunks it is about to
 * delete — planRetirement runs first precisely so the retired URLs can be handed
 * to createSnapshot with the rest of the run's affected URLs.
 *
 * @param {string} domain
 * @param {object} plan from planRetirement
 * @returns {Promise<{pages: number, chunks: number, bumped: number, reset: number, skipped: string|null}>}
 */
async function applyRetirement(domain, plan = {}) {
  const retire = plan.retire || [];
  const bump = plan.bump || [];
  const reset = plan.reset || [];
  const out = { pages: 0, chunks: 0, bumped: 0, reset: 0, skipped: plan.skipped || null };

  if (retire.length > 0) {
    const urls = retire.map((r) => r.url);
    const del = await Chunk.deleteMany({ domain, url: { $in: urls }, source: { $nin: PRESERVED_SOURCES } });
    out.chunks = del?.deletedCount || 0;
    const rows = await ScrapedPage.deleteMany({ domain, url: { $in: urls } });
    out.pages = rows?.deletedCount || 0;
    const byReason = retire.reduce((acc, r) => ({ ...acc, [r.reason]: (acc[r.reason] || 0) + 1 }), {});
    debug('light', `${domain}: retired ${out.pages} page row(s) and ${out.chunks} scraped chunk(s) — source: ${Object.entries(byReason).map(([k, v]) => `${v} ${k}`).join(', ')}; owner-authored chunks at those URLs were preserved`);
  }

  // One atomic $inc rather than a read-modify-write per page: the value the plan
  // was computed on is only used to decide retirement, never written back.
  if (bump.length > 0) {
    const res = await ScrapedPage.updateMany({ domain, url: { $in: bump } }, { $inc: { missedCrawls: 1 } });
    out.bumped = res?.modifiedCount ?? bump.length;
  }
  if (reset.length > 0) {
    const res = await ScrapedPage.updateMany({ domain, url: { $in: reset } }, { missedCrawls: 0 });
    out.reset = res?.modifiedCount ?? reset.length;
  }
  if (out.bumped > 0 || out.reset > 0) {
    debug('normal', `${domain}: ${out.bumped} page(s) took a miss, ${out.reset} had their miss counter cleared — source: this crawl's reach`);
  }

  return out;
}

module.exports = {
  planRetirement,
  applyRetirement,
  pageKey,
  reachedKeys,
  MAX_MISSES,
  MIN_REACH_RATIO,
  MAX_RETIRE_RATIO,
  MIN_RETIRE_FLOOR,
  GONE_STATUSES,
};
