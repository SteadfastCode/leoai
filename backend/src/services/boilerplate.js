// Site-wide boilerplate strip (LEO-141).
//
// Measured in the 2026-11-14 scrape audit: the reCAPTCHA notice survived into
// 139 harvestlanefarmmarket.com chunks and the Squarespace consent banner into
// 46% of gbclancaster.org chunks. LEO-132 took the consent banners by selector
// and by phrase, which is the right mechanism for a known, finite list of
// vendors. What is left is the rest of a site's chrome — the reCAPTCHA notice,
// a "© 2026 …" line, a newsletter pitch, a nav list Puppeteer rendered as text,
// the footer address block — and no vendor list can enumerate that.
//
// scraper.js already dedups paragraphs across pages (seenParaHashes), but three
// gaps let site chrome through:
//
//   1. BOILERPLATE_MAX — a repeated paragraph longer than 200 chars is kept on
//      EVERY page, on the theory that it may be real content.
//   2. Thin-page cards (buildGroupChunks) deliberately skip that dedup so a
//      staff card's name and email are never silently dropped — so every card
//      in a group chunk carries the chrome too.
//   3. A rescrape starts with an empty seenParaHashes and only re-embeds the
//      pages that changed, so whichever page is handled first re-admits the
//      chrome. Over many refreshes it accumulates across the corpus.
//
// This module closes all three with ONE mechanism: fingerprint every eligible
// block of every page in a crawl, and treat a block that appears on at least
// MIN_RATIO of the pages (and on at least MIN_PAGES of them) as site-wide.
// Those fingerprints are stripped wherever scraper.js filters paragraphs —
// keepPara is the single call site, so normal pages AND thin-page cards are
// covered — and ONE copy of each is kept as a single 'Site-wide info' chunk,
// because a church footer is often the only place the service times and the
// street address appear at all.
//
// How it fits progressive saves (44ecec0). Chunks are written to MongoDB per
// URL during the crawl, so the full tally does not exist yet when the first
// pages are stored. The crawl therefore strips the PREVIOUS crawl's
// fingerprints (cached on the Entity) and recomputes the set at the end for the
// next one. A first-ever crawl of a site strips nothing and converges on the
// next refresh; it still gets its 'Site-wide info' chunk immediately.
//
// Why bios are safe (0a0ab27). Headings are never eligible — "H1/H2/H3 are
// always exempt from dedup" is a repo-wide invariant — and a bio that appears
// on a listing page and its own detail page is on 2 pages, under MIN_PAGES. The
// pass does not engage at all on a site of fewer than MIN_SITE_PAGES pages, so
// a 4-page site cannot have a third of its prose called chrome. And a stripped
// block is never destroyed: it is in the 'Site-wide info' chunk.
//
// Debug tiers — BOILERPLATE_LOG_LEVEL = off | light | normal | verbose:
//   off              nothing
//   light (default)  one line when the crawl's set is computed and one when a
//                    cached Pass-1 answer is reused, each naming the SOURCE —
//                    the block's first 70 chars and the page count behind it,
//                    or the date the cached selectors were stored
//   normal           adds every block the threshold rejected, with its count
//   verbose          adds a line per page whose text contributed a fingerprint
//
// Unit-tested in backend/test/boilerplate.test.js against fixture "sites".

const crypto = require('crypto');
const { toParagraphs } = require('./scheduleLines');
const { isConsentParagraph } = require('./consentStrip');

// A block on >= MIN_RATIO of the crawl's pages, on at least MIN_PAGES of them,
// is site-wide. The item's numbers: "~40% of pages (min 3)".
const MIN_RATIO = 0.4;
const MIN_PAGES = 3;
// Below this many pages the ratio means nothing — 3 of 5 pages is 60%, and on a
// small site that is just as likely to be a real paragraph as chrome.
const MIN_SITE_PAGES = 5;
// Blocks shorter than this are tokens, not content ("Menu", "›", "2026").
const MIN_BLOCK_LEN = 8;
// Hard caps on the 'Site-wide info' chunk so it stays a chunk, not a page dump.
const MAX_BLOCKS = 25;
const MAX_CHUNK_LEN = 1700;
// A cached Pass-1 answer older than this is recomputed — sites get redesigned.
const PASS1_MAX_AGE_DAYS = 30;

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.BOILERPLATE_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[Boilerplate] ${message}`);
}

const H_MARKER_RE = /^\[H([123])(?:#([^\]\s]*))?\] /;
const SB_MARKER_RE = /^(?:\[SB\])+/;

/** The text a fingerprint is taken over: markers off, whitespace and case flattened. */
function normalise(p) {
  return String(p ?? '')
    .replace(SB_MARKER_RE, '')
    .replace(/[ ​⁠]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^[\s"'“”‘’(\[-]+|[\s"'“”‘’)\].,;:!-]+$/g, '');
}

/** Stable short fingerprint of one block of page text. */
function fingerprint(p) {
  return crypto.createHash('sha256').update(normalise(p)).digest('hex').slice(0, 16);
}

/**
 * Is this block allowed to be called site-wide chrome?
 *
 * Headings never are (repo-wide invariant). Consent paragraphs are already
 * handled by LEO-132 and must not reach the 'Site-wide info' chunk, which is
 * meant for the footer's service times, not for a cookie notice.
 */
function eligible(p) {
  const bare = String(p ?? '').replace(SB_MARKER_RE, '');
  if (H_MARKER_RE.test(bare)) return false;
  if (normalise(bare).length < MIN_BLOCK_LEN) return false;
  if (isConsentParagraph(bare)) return false;
  return true;
}

/**
 * Does keepPara drop this paragraph as known site-wide chrome?
 *
 * `cs.boilerplate` is the Set the current crawl was started with — the PREVIOUS
 * crawl's fingerprints. Absent (every caller outside a crawl, and every crawl of
 * a site that has never been fingerprinted) means "strip nothing".
 */
function isBoilerplate(p, cs = {}) {
  const known = cs && cs.boilerplate;
  if (!known || typeof known.has !== 'function' || known.size === 0) return false;
  if (!eligible(p)) return false;
  return known.has(fingerprint(p));
}

// Blocks that carry the information a visitor actually asks for go into the
// 'Site-wide info' chunk first, so a cap can only ever drop the dross.
const INFO_RE = [
  /\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)/i,                       // clock time
  /\b(sun|mon|tue|wed|thu|fri|sat)(day|s|\.)?\b/i,                   // weekday
  /\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/,                             // phone
  /\S+@\S+\.\S+/,                                                     // email
  /\b\d+\s+[\w.'-]+\s+(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|pike|way|ct|court)\b/i,
  /\b[A-Z]{2}\s+\d{5}\b/,                                            // state + ZIP
  /[$€£¥]\s*\d/,                                                      // price
];

function infoScore(text) {
  return INFO_RE.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
}

/** The synthetic URL the 'Site-wide info' chunk is filed under. */
function siteWideUrlFor(baseUrl) {
  try {
    return `${new URL(baseUrl).origin}/#site-wide`;
  } catch {
    return `${String(baseUrl).replace(/\/+$/, '')}/#site-wide`;
  }
}

/**
 * Build the single 'Site-wide info' chunk's content from the detected blocks.
 * Returns null when there is nothing worth keeping.
 */
function buildSiteWideContent(blocks, baseUrl) {
  const ranked = [...blocks]
    .map((b, i) => ({ ...b, rank: infoScore(b.text), i }))
    .sort((a, b) => b.rank - a.rank || b.pages - a.pages || a.i - b.i)
    .slice(0, MAX_BLOCKS);

  const kept = [];
  let len = 0;
  for (const b of ranked) {
    if (len + b.text.length + 2 > MAX_CHUNK_LEN && kept.length > 0) continue;
    kept.push(b.text);
    len += b.text.length + 2;
  }
  if (kept.length === 0) return null;

  let host = baseUrl;
  try { host = new URL(baseUrl).hostname; } catch { /* keep the raw string */ }
  return `[Source: ${siteWideUrlFor(baseUrl)}]\n[H1] Site-wide info\n\nThis information appears on every page of ${host}.\n\n${kept.join('\n\n')}`;
}

/**
 * Per-crawl tracker.
 *
 * `known` — the previous crawl's fingerprints, stripped during this one.
 * `note(pages)` — tally one batch of fetched pages. Called with RAW page text,
 *   before any filtering, so the recomputed set is self-correcting: a block the
 *   site has stopped repeating falls out and goes back to living in its page.
 * `report()` — the set for the next crawl, plus the blocks behind it.
 * `siteWideChunk(embed)` — one embedded chunk, or null.
 */
function createChromeTracker({ known = [], baseUrl = '', domain = '' } = {}) {
  const knownSet = new Set(Array.isArray(known) ? known : []);
  const tally = new Map(); // fingerprint → { text, pages }
  let pageCount = 0;

  function note(pages = []) {
    for (const page of pages) {
      if (!page || typeof page.text !== 'string') continue;
      pageCount += 1;
      const seenHere = new Set(); // a block repeated WITHIN one page counts once
      let noted = 0;
      for (const p of toParagraphs(page.text)) {
        if (!eligible(p)) continue;
        const fp = fingerprint(p);
        if (seenHere.has(fp)) continue;
        seenHere.add(fp);
        noted += 1;
        const entry = tally.get(fp);
        if (entry) entry.pages += 1;
        else tally.set(fp, { text: String(p).replace(SB_MARKER_RE, '').trim(), pages: 1 });
      }
      if (noted > 0) debug('verbose', `${domain || baseUrl}: ${page.url} contributed ${noted} block fingerprint(s)`);
    }
  }

  function detected() {
    if (pageCount < MIN_SITE_PAGES) return [];
    const floor = Math.max(MIN_PAGES, Math.ceil(MIN_RATIO * pageCount));
    const hits = [];
    for (const [fp, entry] of tally) {
      if (entry.pages >= floor) hits.push({ fp, text: entry.text, pages: entry.pages });
      else if (entry.pages >= MIN_PAGES) {
        debug('normal', `${domain || baseUrl}: kept "${entry.text.slice(0, 70)}" — source: on ${entry.pages}/${pageCount} pages, under the ${floor}-page floor`);
      }
    }
    return hits.sort((a, b) => b.pages - a.pages || a.text.localeCompare(b.text));
  }

  function report() {
    const hits = detected();
    for (const h of hits) {
      const already = knownSet.has(h.fp) ? 'already stripped this crawl' : 'NEW — stripped from the next crawl on';
      debug('light', `${domain || baseUrl}: site-wide "${h.text.slice(0, 70)}" — source: on ${h.pages}/${pageCount} pages, ${already}`);
    }
    if (pageCount < MIN_SITE_PAGES) {
      debug('light', `${domain || baseUrl}: no site-wide pass — source: ${pageCount} page(s) crawled, under the ${MIN_SITE_PAGES}-page floor`);
    }
    return {
      fingerprints: hits.map((h) => h.fp),
      blocks: hits.map((h) => h.text),
      pageCount,
    };
  }

  /**
   * The crawl's single 'Site-wide info' chunk, embedded. `embed` is injected
   * (scraper.js passes embeddings.embedTexts) so this module stays testable
   * without a network call.
   */
  async function siteWideChunk(embed) {
    const hits = detected();
    if (hits.length === 0 || typeof embed !== 'function') return null;
    const content = buildSiteWideContent(hits, baseUrl);
    if (!content) return null;
    const url = siteWideUrlFor(baseUrl);
    const [embedding] = await embed([content]);
    if (!embedding) return null;
    debug('light', `${domain || baseUrl}: 'Site-wide info' chunk built — source: ${hits.length} site-wide block(s), ${content.length} chars, filed at ${url}`);
    return {
      content,
      url,
      embedding,
      chunkIndex: 0,
      pageH1: 'Site-wide info',
      sectionH2: null,
      label: 'Site-wide info',
      sourceUrls: [url],
    };
  }

  return { known: knownSet, note, report, siteWideChunk, detected };
}

/**
 * Pass-1 Haiku selector cache (LEO-141).
 *
 * The structural analysis is one Haiku call per crawl over a truncated DOM
 * summary, and Haiku is not deterministic: a different answer changes what is
 * stripped from every page, which changes every page's content hash, which
 * makes a smart rescrape re-embed the entire site. Reusing the stored answer
 * makes "nothing changed" mean the site did not change.
 */
async function cachedStructure(cache, compute) {
  const exclude = cache?.pass1Exclude || [];
  const include = cache?.pass1Include || [];
  const at = cache?.pass1At ? new Date(cache.pass1At) : null;
  const ageDays = at ? (Date.now() - at.getTime()) / 86_400_000 : Infinity;
  if ((exclude.length || include.length) && ageDays <= PASS1_MAX_AGE_DAYS) {
    debug('light', `pass 1: reused ${exclude.length} exclude + ${include.length} include selector(s) — source: entity cache stored ${at ? at.toISOString() : 'unknown'}`);
    // `cached` keeps chromeUpdate from re-stamping pass1At: bumping it on a cache
    // HIT would slide the expiry window forward on every crawl, and the selectors
    // would never be recomputed however old the site's redesign made them.
    return { exclude: [...exclude], include: [...include], cached: true };
  }
  if (exclude.length || include.length) {
    debug('light', `pass 1: recomputing — source: cached selectors are ${Math.round(ageDays)} days old, over the ${PASS1_MAX_AGE_DAYS}-day limit`);
  }
  return compute();
}

/**
 * The Entity `$set` payload for a crawl result. Dotted keys so writing the
 * fingerprints never wipes the Pass-1 cache and vice versa.
 */
function chromeUpdate({ siteChrome = null, pass1Filters = null } = {}) {
  const set = {};
  if (siteChrome && Array.isArray(siteChrome.fingerprints)) {
    set['siteChrome.fingerprints'] = siteChrome.fingerprints;
    set['siteChrome.blocks'] = siteChrome.blocks || [];
    set['siteChrome.pageCount'] = siteChrome.pageCount || 0;
    set['siteChrome.at'] = new Date();
  }
  if (pass1Filters && !pass1Filters.cached && ((pass1Filters.exclude || []).length || (pass1Filters.include || []).length)) {
    set['siteChrome.pass1Exclude'] = pass1Filters.exclude || [];
    set['siteChrome.pass1Include'] = pass1Filters.include || [];
    set['siteChrome.pass1At'] = new Date();
  }
  return set;
}

module.exports = {
  createChromeTracker,
  isBoilerplate,
  buildSiteWideContent,
  siteWideUrlFor,
  cachedStructure,
  chromeUpdate,
  fingerprint,
  eligible,
  MIN_RATIO,
  MIN_PAGES,
  MIN_SITE_PAGES,
  PASS1_MAX_AGE_DAYS,
};
