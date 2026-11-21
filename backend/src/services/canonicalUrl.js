// One canonical spelling per page (LEO-137).
//
// From the 2026-11-14 scrape audit. The same page was stored under several URL
// spellings and nothing downstream could tell they were the same page:
//
//   - westpca.com had 11 trailing-slash pairs, the same chunk text filed under
//     up to four URLs (http/https × www/bare × slash/no-slash).
//   - campcalvary.com kept /camps/mr and /camps/mr/ as two ScrapedPage rows.
//
// urlKey() in scraper.js deduped the CRAWL on hostname+pathname, so each page
// was only fetched once — but the URL that was stored was whatever string
// happened to be queued first. From there:
//
//   - chunk.url kept that string, and so did the [Source: …] line inside the
//     chunk's text, which is what Leo cites.
//   - getGroupUrl() built the group URL with u.href, which always appends '/'.
//   - LeoRefresh starts from `https://${domain}` — no www, no slash.
//   - scrapePersist matches { domain, url } EXACTLY, so chunks stored under one
//     spelling were never replaced by a rescrape that queued another. They just
//     accumulated.
//
// Chunk-hash dedup cannot catch any of it: the [Source: url] line is inside the
// hashed text, so two copies of one page under two spellings hash differently.
//
// The fix is one function, used everywhere a URL is stored. The crawl may still
// FETCH whatever a site links — only the stored spelling is normalised.
//
// What canonical means here, in the order applied:
//   1. host lowercased (WHATWG URL does this, asserted anyway)
//   2. scheme + host replaced with the entity's canonical origin, but ONLY when
//      the URL is on the same site (same host after dropping a leading 'www.').
//      A subdomain — shop.example.com — keeps its own host AND its own scheme:
//      forcing https on a subdomain that only serves http would lose the page,
//      and subdomain crawling is a shipped feature (see CLAUDE.md).
//   3. the hash dropped
//   4. tracking parameters dropped — the SAME list crawlFilter uses (LEO-136),
//      imported rather than copied so the two can never drift
//   5. the trailing slash dropped, except on the root
//
// Deliberately NOT done: dropping the whole query string. urlKey() already
// dedups on hostname+pathname, so '?page=2' is already collapsed for crawl
// purposes; dropping it from the stored URL would change which URL is FETCHED
// on the next run and could turn a real page into the home page.
//
// Debug tiers — CANONICAL_URL_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) the resolved canonical origin per site, naming WHY it was
//                   chosen (home-page redirect, or the base URL unchanged), and
//                   every rewrite the redirect caused
//   normal          adds one line per URL whose spelling changed, naming which
//                   of the five rules changed it
//   verbose         adds every URL that was already canonical
// A canonicalised URL is invisible in the result — a page count that differs
// and nothing else — so even the light tier names the SOURCE of the decision.

const axios = require('axios');
const { isTrackingParam } = require('./crawlFilter');
const { LEO_USER_AGENT } = require('./robots');

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.CANONICAL_URL_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[CanonicalUrl] ${message}`);
}

/** The host with a leading 'www.' removed — the two spellings of one site. */
function apexHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

/**
 * Is `host` the same SITE as `baseHost` — the www/bare pair of one host?
 * Subdomains are a different site by this test (they get their own origin).
 */
function sameSite(host, baseHost) {
  const a = apexHost(host);
  const b = apexHost(baseHost);
  return !!a && a === b;
}

/**
 * Is `host` inside the crawl for a site rooted at `baseHost`? True for the
 * host itself, for its www/bare counterpart, and for any subdomain of the apex.
 *
 * Replaces the `h === baseDomain || h.endsWith('.' + baseDomain)` test the
 * crawl loop used to inline. That test broke the moment baseDomain became a
 * www host: 'shop.westpca.com'.endsWith('.www.westpca.com') is false, so every
 * shop subdomain would have silently stopped being crawled.
 */
function inSite(host, baseHost) {
  const h = String(host || '').toLowerCase();
  const apex = apexHost(baseHost);
  if (!h || !apex) return false;
  return h === apex || h.endsWith('.' + apex);
}

/**
 * The one canonical spelling of a URL.
 *
 * @param {string|null} urlStr absolute URL. null/'' passes straight through so
 *   this composes with crawlFilter's crawlableUrl(), which returns null to skip.
 * @param {string|null} origin the site's canonical origin ('https://www.x.com'),
 *   from resolveCanonicalOrigin(). Omitted: scheme and host are left as given
 *   (still lowercased) and only rules 3–5 apply.
 * @returns {string|null} the canonical URL. Never throws — an unparseable URL
 *   comes back unchanged, because a normalisation bug must not lose a page.
 */
function canonicalUrl(urlStr, origin = null) {
  if (!urlStr) return urlStr ?? null;
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    debug('normal', `left as-is: ${urlStr} — source: not a parseable URL`);
    return urlStr;
  }

  const rules = [];
  const beforeHost = u.hostname;
  u.hostname = u.hostname.toLowerCase();
  if (u.hostname !== beforeHost) rules.push('host lowercased');

  if (origin) {
    let o;
    try { o = new URL(origin); } catch { o = null; }
    if (o && sameSite(u.hostname, o.hostname)) {
      if (u.protocol !== o.protocol) { u.protocol = o.protocol; rules.push(`scheme → ${o.protocol}`); }
      if (u.host !== o.host) { u.host = o.host; rules.push(`host → ${o.host}`); }
    }
  }

  if (u.hash) { u.hash = ''; rules.push('hash dropped'); }

  const tracking = [...u.searchParams.keys()].filter(isTrackingParam);
  for (const key of tracking) u.searchParams.delete(key);
  if (tracking.length) rules.push(`tracking params dropped (${tracking.join(', ')})`);

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
    rules.push('trailing slash dropped');
  }

  const out = u.href;
  if (rules.length) debug('normal', `${urlStr} → ${out} — source: ${rules.join('; ')}`);
  else debug('verbose', `${out} — source: already canonical`);
  return out;
}

/**
 * The entity's canonical origin, from the FIRST redirect of its home page.
 *
 * `http://westpca.com` answering 301 → `https://www.westpca.com/` is the site
 * telling us which of the four spellings it considers its own. Only the origin
 * is taken, and only when the redirect stays on the same site: a redirect to a
 * DIFFERENT domain is a migration, and adopting it here would silently re-point
 * the whole crawl (and every stored URL) at a host the entity never configured.
 *
 * Never throws and never blocks a scrape: any failure — DNS, timeout, a 500, no
 * Location header — falls back to the base URL's own origin, which is exactly
 * the behaviour before this existed.
 *
 * @param {string} baseUrl the entity's start URL
 * @param {{get?: Function, timeout?: number}} [deps] injection seam for tests
 * @returns {Promise<string|null>} e.g. 'https://www.westpca.com'
 */
async function resolveCanonicalOrigin(baseUrl, deps = {}) {
  const get = deps.get || axios.get;
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    debug('light', `no canonical origin for ${baseUrl} — source: base URL is not parseable`);
    return null;
  }
  const fallback = base.origin;

  try {
    const resp = await get(base.href, {
      timeout: deps.timeout ?? 10000,
      maxRedirects: 0,
      // maxRedirects 0 + validateStatus makes axios HAND BACK the 3xx instead of
      // throwing, which is the whole point: we want to read the Location header.
      validateStatus: () => true,
      headers: { 'User-Agent': LEO_USER_AGENT },
    });
    const status = Number(resp?.status);
    const location = resp?.headers?.location || resp?.headers?.Location;
    if (!(status >= 300 && status < 400) || !location) {
      debug('light', `canonical origin ${fallback} — source: home page answered ${status || 'no status'}, no redirect`);
      return fallback;
    }
    const target = new URL(location, base.href);
    if (!sameSite(target.hostname, base.hostname)) {
      debug('light', `canonical origin ${fallback} — source: home page redirects off-site to ${target.origin}, not adopted`);
      return fallback;
    }
    if (target.origin !== fallback) {
      debug('light', `canonical origin ${target.origin} — source: home-page ${status} redirect from ${fallback}`);
    } else {
      debug('light', `canonical origin ${fallback} — source: home-page ${status} redirect kept the same origin`);
    }
    return target.origin;
  } catch (err) {
    debug('light', `canonical origin ${fallback} — source: redirect probe failed (${err.message})`);
    return fallback;
  }
}

module.exports = {
  canonicalUrl,
  resolveCanonicalOrigin,
  apexHost,
  sameSite,
  inSite,
};
