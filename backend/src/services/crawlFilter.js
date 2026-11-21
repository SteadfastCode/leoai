// Non-content URLs at enqueue, and near-empty chunks at embed (LEO-136).
//
// From the 2026-11-14 scrape audit. Link collection in scraper.js filtered '#'
// and 'mailto:' links and nothing else, so a crawl followed whatever a theme
// rendered: harvestlanefarmmarket.com came back as 547 pages — 450 of them
// under /product/, 344 carrying Square's navigation query string
// (?cp=&sa=&sbp=&q=&category_id=) — and produced ~255 chunks whose whole body
// was '95 Add to cart' plus 471 exact duplicates; gbclancaster.org crawled
// /cart, whose empty page was then packed into the home-page group chunk.
//
// Two separate problems, so two separate halves here:
//
//   1. ENQUEUE — a URL that is a shop mechanism (cart, checkout, account), a
//      taxonomy listing (tag, category, author), a feed or an API route, theme
//      pagination, or a media/archive file is never queued. A URL that is a
//      real page reached through tracking parameters is queued WITH THOSE
//      PARAMETERS STRIPPED rather than skipped — skipping it would lose a page
//      that is only ever linked with them, and urlKey() in scraper.js already
//      dedups on hostname+pathname, so the strip changes which variant gets
//      fetched and stored (and therefore which URL Leo cites), not how many
//      pages are fetched.
//   2. EMBED — a chunk whose body is under MIN_CHUNK_BODY chars once the
//      leading header block and every [Source: …] line are discounted is
//      dropped before embedding. See chunkBody() for exactly what counts.
//
// Deliberately NOT here: /product/ and /product-category/ stay crawlable. The
// item is explicit that whether a shop's catalogue belongs in the KB at all is
// a separate question — this only stops the pages that are plainly not content,
// and the near-empty rule cleans up what the catalogue pages produce.
//
// scraper.js is a restricted file (≤30 changed lines), so all of the decision
// lives here and the crawl loop gets one call per site — same split as
// robots.js (LEO-071) and fetchFailure.js (LEO-056).
//
// Debug tiers — CRAWL_FILTER_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) one line per skipped URL naming the RULE that skipped it,
//                   and one per dropped chunk naming its measured body length
//   normal          adds every URL whose tracking parameters were stripped,
//                   naming the parameters removed, and the per-call totals
//   verbose         adds the dropped chunk's body text, and every URL that
//                   passed both halves untouched
// A skipped URL and a dropped chunk are both invisible in the result — a
// smaller page or chunk count and nothing else — so even the light tier names
// the SOURCE of the decision rather than only the count.

// A chunk body shorter than this is not worth an embedding: '95 Add to cart'
// is 14 chars, a card with only a name is around 20. Kept small on purpose —
// a real but terse answer ('Closed Sundays', 14 chars) reaches a chunk only
// as part of a page or group with more text around it.
const MIN_CHUNK_BODY = 40;

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.CRAWL_FILTER_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[CrawlFilter] ${message}`);
}

// ── Enqueue: path segments that are never content ──────────────────────────

// Matched against whole path SEGMENTS, so /cart and /shop/cart both match while
// /golf-cart-rentals does not. The value is the rule name that gets logged.
const SKIP_SEGMENTS = new Map([
  ['cart', 'cart'],
  ['checkout', 'checkout'],
  ['account', 'account'],
  ['my-account', 'account'],
  ['login', 'auth'],
  ['register', 'auth'],
  ['search', 'search'],
  ['tag', 'taxonomy'],
  ['tags', 'taxonomy'],
  ['product-tag', 'taxonomy'],
  ['category', 'taxonomy'],
  ['author', 'taxonomy'],
  ['feed', 'feed'],
  ['wp-json', 'api'],
]);

// Media the crawl can do nothing with. Documents are NOT here: a .pdf is parsed
// by fetchPage and .doc/.docx/.xlsx are followed one hop by linkedDocs (LEO-144),
// so listing them would silently undo that feature.
const ASSET_EXT_RE =
  /\.(jpe?g|png|gif|webp|svg|ico|bmp|tiff?|avif|heic|mp3|mp4|m4a|mov|avi|wmv|webm|mkv|wav|ogg|flac|zip|tar|t?gz|rar|7z|bz2|dmg|iso|exe)$/i;

// Theme pagination — /page/2, /blog/page/13. The listing page itself stays.
const PAGINATION_RE = /\/page\/\d+\/?$/i;

// Query parameters that mean "this is a mechanism, not a page".
const SKIP_PARAMS = new Set(['format', 'add-to-cart', 'replytocom']);

// Fragments that mark a form rather than a section of the page.
const SKIP_HASHES = new Set(['#respond']);

/**
 * The rules, in the order they are tested. Each takes the parsed URL plus its
 * lower-cased path segments and returns true when it claims the URL.
 *
 * Exported so the tests name the same rules the logs do.
 */
const NON_CONTENT_RULES = [
  {
    rule: 'segment',
    test: (_u, segments) => segments.some((s) => SKIP_SEGMENTS.has(s)),
    // The reported rule is the segment's own name, resolved below.
  },
  { rule: 'pagination', test: (u) => PAGINATION_RE.test(u.pathname) },
  { rule: 'asset', test: (u) => ASSET_EXT_RE.test(u.pathname) },
  { rule: 'query', test: (u) => [...u.searchParams.keys()].some((k) => SKIP_PARAMS.has(k.toLowerCase())) },
  { rule: 'fragment', test: (u) => SKIP_HASHES.has(u.hash.toLowerCase()) },
];

// ── Enqueue: tracking parameters that are stripped, not skipped ────────────

// Square's shop navigation context (cp/sa/sbp/q/si/category_id) plus the usual
// ad-network and analytics tags. Every one of these describes how a visitor
// arrived, never which page they arrived at.
const TRACKING_PARAMS = new Set([
  'cp', 'sa', 'sbp', 'q', 'si', 'category_id',
  'gclid', 'fbclid', 'msclkid', 'igshid', 'yclid', 'twclid', 'srsltid',
  'mc_cid', 'mc_eid', '_ga', '_gl', 'ref', 'referrer',
]);

function isTrackingParam(key) {
  const k = String(key).toLowerCase();
  return TRACKING_PARAMS.has(k) || k.startsWith('utm_');
}

/**
 * Drop tracking parameters from a URL, preserving everything else and the order
 * of what is left.
 *
 * @param {string} urlStr absolute URL
 * @returns {{url: string, stripped: string[]}} the URL with those parameters
 *   gone (unchanged when there were none) and the names that were removed
 */
function stripTrackingParams(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return { url: urlStr, stripped: [] };
  }
  const stripped = [...u.searchParams.keys()].filter(isTrackingParam);
  if (stripped.length === 0) return { url: u.href, stripped: [] };
  for (const key of stripped) u.searchParams.delete(key);
  return { url: u.href, stripped };
}

/**
 * Decide what the crawl should do with one discovered URL. Pure — logs nothing.
 *
 * @param {string} urlStr absolute URL, as resolved against the linking page
 * @returns {{url: string|null, rule: string|null, stripped: string[]}}
 *   url is null when the URL must not be queued, and otherwise the URL to
 *   queue, which may differ from the input by its query string. rule names the
 *   rule that skipped it. Never throws: an unparseable URL comes back unchanged
 *   and unskipped, because a filter bug must not be able to lose a page.
 */
function classifyCrawlUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return { url: urlStr, rule: null, stripped: [] };
  }

  const segments = u.pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
  for (const { rule, test } of NON_CONTENT_RULES) {
    if (!test(u, segments)) continue;
    if (rule !== 'segment') return { url: null, rule, stripped: [] };
    const hit = segments.find((s) => SKIP_SEGMENTS.has(s));
    return { url: null, rule: SKIP_SEGMENTS.get(hit), stripped: [] };
  }

  const { url, stripped } = stripTrackingParams(u.href);
  return { url, rule: null, stripped };
}

/**
 * The one call the crawl loop makes per discovered URL.
 *
 * @param {string} urlStr absolute URL
 * @returns {string|null} the URL to queue, or null to skip it
 */
function crawlableUrl(urlStr) {
  const { url, rule, stripped } = classifyCrawlUrl(urlStr);
  if (url === null) {
    debug('light', `not queued: ${urlStr} — source: rule ${rule}`);
    return null;
  }
  if (stripped.length > 0) {
    debug('normal', `queued ${url} — source: tracking params stripped (${stripped.join(', ')}) from ${urlStr}`);
  } else {
    debug('verbose', `queued ${url} — source: no rule matched`);
  }
  return url;
}

// ── Embed: chunks with no body left ───────────────────────────────────────

const HEADER_LINE_RE = /^\s*(\[Source:[^\]]*\]|\[H[1-6]\].*)\s*$/;
const SOURCE_LINE_RE = /^\s*\[Source:[^\]]*\]\s*$/;

/**
 * The part of a chunk a reader would call content.
 *
 * Two things are discounted, and only these two:
 *   - the LEADING header block — the run of [Source:]/[H1]/[H2] lines at the
 *     very top, which is the page's own provenance and title, repeated on every
 *     chunk of that page. The run stops at the first line that is not one of
 *     them, which in a multi-URL group chunk is the blank line after
 *     [Source: groupUrl] — so each card's own [H1] still counts as content and
 *     a staff group whose cards are nothing but names survives (LEO-083).
 *   - every remaining [Source: …] line, wherever it is. A URL is provenance in
 *     any position, and a group chunk packing cards that rendered no text at
 *     all is otherwise 110 chars of URL and nothing else.
 *
 * @param {string} content chunk content as built by chunkText/buildGroupChunks
 * @returns {string} whitespace-collapsed body text
 */
function chunkBody(content) {
  const lines = String(content ?? '').split('\n');
  let i = 0;
  while (i < lines.length && HEADER_LINE_RE.test(lines[i])) i++;
  return lines
    .slice(i)
    .filter((line) => !SOURCE_LINE_RE.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when this chunk has nothing left worth embedding. */
function isNearEmptyChunk(content) {
  return chunkBody(content).length < MIN_CHUNK_BODY;
}

/**
 * Drop the near-empty chunks from a list, logging each one.
 *
 * Runs before dedup and embedding in both chunk paths, so a dropped chunk costs
 * no embedding call and never reaches MongoDB. chunkIndex is left as it was:
 * dropping a chunk leaves a gap in the sequence, which is harmless — nothing
 * indexes by it, and the order of what remains is unchanged.
 *
 * @param {Array<{content: string, url?: string}>} chunks
 * @returns {Array} the chunks worth keeping
 */
function dropNearEmptyChunks(chunks) {
  const list = Array.isArray(chunks) ? chunks : [];
  const kept = list.filter((chunk) => {
    const body = chunkBody(chunk && chunk.content);
    if (body.length >= MIN_CHUNK_BODY) return true;
    debug('light', `dropped near-empty chunk ${chunk && chunk.url} — source: body ${body.length} chars (< ${MIN_CHUNK_BODY})`);
    debug('verbose', `  body was: ${JSON.stringify(body)}`);
    return false;
  });
  if (kept.length !== list.length) {
    debug('normal', `${list.length - kept.length} of ${list.length} chunk(s) dropped as near-empty`);
  }
  return kept;
}

module.exports = {
  MIN_CHUNK_BODY,
  NON_CONTENT_RULES,
  SKIP_SEGMENTS,
  TRACKING_PARAMS,
  classifyCrawlUrl,
  crawlableUrl,
  isTrackingParam,
  stripTrackingParams,
  chunkBody,
  isNearEmptyChunk,
  dropNearEmptyChunks,
};
