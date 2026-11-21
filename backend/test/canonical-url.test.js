// One canonical spelling per page (LEO-137).
//
// Every variant here is one the 2026-11-14 scrape audit actually found:
// westpca.com's http/https × www/bare × slash/no-slash quads, and
// campcalvary.com's /camps/mr vs /camps/mr/ page pair. The redirect probe is
// driven through an injected `get`, so nothing in this file contacts a site.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CANONICAL_URL_LOG_LEVEL = 'off';

const {
  canonicalUrl,
  resolveCanonicalOrigin,
  apexHost,
  sameSite,
  inSite,
} = require('../src/services/canonicalUrl');

const WEST = 'https://www.westpca.com';
const CAMP = 'https://campcalvary.com';

// ── The audit's variants, each collapsing to one spelling ──────────────────

test('westpca: all four spellings of one page collapse to one URL', () => {
  const variants = [
    'http://westpca.com/camps/mr',
    'http://westpca.com/camps/mr/',
    'https://westpca.com/camps/mr',
    'https://westpca.com/camps/mr/',
    'http://www.westpca.com/camps/mr',
    'http://www.westpca.com/camps/mr/',
    'https://www.westpca.com/camps/mr',
    'https://www.westpca.com/camps/mr/',
  ];
  const canonical = new Set(variants.map((u) => canonicalUrl(u, WEST)));
  assert.deepEqual([...canonical], ['https://www.westpca.com/camps/mr']);
});

test('campcalvary: /camps/mr and /camps/mr/ are one page', () => {
  assert.equal(
    canonicalUrl('https://campcalvary.com/camps/mr/', CAMP),
    canonicalUrl('https://campcalvary.com/camps/mr', CAMP),
  );
  assert.equal(canonicalUrl('https://campcalvary.com/camps/mr/', CAMP), 'https://campcalvary.com/camps/mr');
});

test('the root keeps its slash, and the slash-less root reaches the same URL', () => {
  assert.equal(canonicalUrl('https://campcalvary.com', CAMP), 'https://campcalvary.com/');
  assert.equal(canonicalUrl('https://campcalvary.com/', CAMP), 'https://campcalvary.com/');
  // LeoRefresh's start URL is exactly this shape — `https://${domain}`, no slash.
  assert.equal(canonicalUrl('https://westpca.com', WEST), 'https://www.westpca.com/');
});

test('host case is normalised', () => {
  assert.equal(canonicalUrl('https://WestPCA.COM/About/', WEST), 'https://www.westpca.com/About');
});

test('the path keeps its case — a URL path is case-sensitive', () => {
  assert.equal(canonicalUrl('https://www.westpca.com/Camps/MR', WEST), 'https://www.westpca.com/Camps/MR');
});

test('the hash is dropped', () => {
  assert.equal(canonicalUrl('https://www.westpca.com/camps#schedule', WEST), 'https://www.westpca.com/camps');
  assert.equal(canonicalUrl('https://www.westpca.com/#top', WEST), 'https://www.westpca.com/');
});

test('tracking params are dropped and real params are kept', () => {
  assert.equal(
    canonicalUrl('https://www.westpca.com/give?utm_source=fb&fbclid=abc&fund=missions', WEST),
    'https://www.westpca.com/give?fund=missions',
  );
  // The whole query being tracking leaves no '?' behind.
  assert.equal(canonicalUrl('https://www.westpca.com/give?utm_medium=email', WEST), 'https://www.westpca.com/give');
});

test('the query string is NOT dropped wholesale — it decides which page is fetched', () => {
  assert.equal(
    canonicalUrl('https://shop.harvestlanefarmmarket.com/product?id=99', 'https://harvestlanefarmmarket.com'),
    'https://shop.harvestlanefarmmarket.com/product?id=99',
  );
});

test('multiple trailing slashes collapse', () => {
  assert.equal(canonicalUrl('https://www.westpca.com/camps///', WEST), 'https://www.westpca.com/camps');
});

// ── Subdomains keep their own host AND their own scheme ────────────────────

test('a subdomain is never rewritten to the canonical host', () => {
  assert.equal(
    canonicalUrl('https://shop.harvestlanefarmmarket.com/jam/', 'https://harvestlanefarmmarket.com'),
    'https://shop.harvestlanefarmmarket.com/jam',
  );
});

test('a subdomain keeps http — forcing https could lose the page', () => {
  assert.equal(
    canonicalUrl('http://shop.harvestlanefarmmarket.com/jam', 'https://harvestlanefarmmarket.com'),
    'http://shop.harvestlanefarmmarket.com/jam',
  );
});

test('an unrelated host is left entirely alone', () => {
  assert.equal(canonicalUrl('https://facebook.com/westpca/', WEST), 'https://facebook.com/westpca');
});

// ── Never loses a URL ─────────────────────────────────────────────────────

test('null and empty pass through, so this composes with crawlableUrl()', () => {
  assert.equal(canonicalUrl(null, WEST), null);
  assert.equal(canonicalUrl(undefined, WEST), null);
  assert.equal(canonicalUrl('', WEST), '');
});

test('an unparseable URL comes back unchanged rather than being dropped', () => {
  assert.equal(canonicalUrl('not a url', WEST), 'not a url');
  assert.equal(canonicalUrl('/relative/path', WEST), '/relative/path');
});

test('a garbage origin is ignored, and the other four rules still apply', () => {
  assert.equal(canonicalUrl('http://westpca.com/camps/mr/#x', 'nonsense'), 'http://westpca.com/camps/mr');
});

test('with no origin, scheme and host are left as given', () => {
  assert.equal(canonicalUrl('http://westpca.com/camps/mr/'), 'http://westpca.com/camps/mr');
});

// ── Host helpers ──────────────────────────────────────────────────────────

test('apexHost strips one leading www', () => {
  assert.equal(apexHost('www.westpca.com'), 'westpca.com');
  assert.equal(apexHost('westpca.com'), 'westpca.com');
  assert.equal(apexHost('shop.westpca.com'), 'shop.westpca.com');
  assert.equal(apexHost(''), '');
  assert.equal(apexHost(undefined), '');
});

test('sameSite pairs www with bare and nothing else', () => {
  assert.equal(sameSite('westpca.com', 'www.westpca.com'), true);
  assert.equal(sameSite('www.westpca.com', 'westpca.com'), true);
  assert.equal(sameSite('shop.westpca.com', 'www.westpca.com'), false);
  assert.equal(sameSite('notwestpca.com', 'westpca.com'), false);
});

test('inSite keeps subdomains crawlable when the canonical host is www', () => {
  // The regression this helper exists to prevent: the old inline test was
  // h.endsWith('.' + baseDomain), and '.www.westpca.com' matches no subdomain.
  assert.equal(inSite('shop.westpca.com', 'www.westpca.com'), true);
  assert.equal(inSite('westpca.com', 'www.westpca.com'), true);
  assert.equal(inSite('www.westpca.com', 'www.westpca.com'), true);
  assert.equal(inSite('deep.shop.westpca.com', 'www.westpca.com'), true);
  assert.equal(inSite('notwestpca.com', 'www.westpca.com'), false);
  assert.equal(inSite('westpca.com.evil.test', 'www.westpca.com'), false);
  assert.equal(inSite('', 'www.westpca.com'), false);
});

// ── The redirect probe ────────────────────────────────────────────────────

const probe = (status, location) => () => Promise.resolve({ status, headers: location ? { location } : {} });

test('a 301 to www is adopted as the canonical origin', async () => {
  const origin = await resolveCanonicalOrigin('http://westpca.com', { get: probe(301, 'https://www.westpca.com/') });
  assert.equal(origin, 'https://www.westpca.com');
});

test('a relative Location header resolves against the base URL', async () => {
  const origin = await resolveCanonicalOrigin('https://campcalvary.com', { get: probe(302, '/home') });
  assert.equal(origin, 'https://campcalvary.com');
});

test('a 200 home page means the base URL is already canonical', async () => {
  const origin = await resolveCanonicalOrigin('https://campcalvary.com', { get: probe(200) });
  assert.equal(origin, 'https://campcalvary.com');
});

test('a redirect to a DIFFERENT site is not adopted', async () => {
  const origin = await resolveCanonicalOrigin('https://westpca.com', { get: probe(301, 'https://squarespace.com/x') });
  assert.equal(origin, 'https://westpca.com');
});

test('a 3xx with no Location header falls back', async () => {
  const origin = await resolveCanonicalOrigin('https://westpca.com', { get: probe(304) });
  assert.equal(origin, 'https://westpca.com');
});

test('a failed probe never blocks a scrape', async () => {
  const origin = await resolveCanonicalOrigin('https://westpca.com', {
    get: () => Promise.reject(new Error('ETIMEDOUT')),
  });
  assert.equal(origin, 'https://westpca.com');
});

test('an unparseable base URL yields no origin rather than throwing', async () => {
  assert.equal(await resolveCanonicalOrigin('not a url', { get: probe(200) }), null);
});

test('the probe asks for no redirects, so the Location header survives', async () => {
  let seen = null;
  await resolveCanonicalOrigin('https://westpca.com', {
    get: (_url, cfg) => { seen = cfg; return Promise.resolve({ status: 200, headers: {} }); },
  });
  assert.equal(seen.maxRedirects, 0);
  assert.equal(seen.validateStatus(301), true);
});

// ── The group URL, the other place u.href re-added a slash ────────────────

test('getGroupUrl no longer re-adds the slash it just stripped', () => {
  const { getGroupUrl } = require('../src/services/scraper');
  // The audit's case: a thin staff card groups under /staff, and the listing
  // page at /staff is the SAME URL rather than a second spelling of it.
  assert.equal(getGroupUrl('https://www.westpca.com/staff/kelly-robinson/'), 'https://www.westpca.com/staff');
  assert.equal(getGroupUrl('https://www.westpca.com/staff/kelly-robinson'), 'https://www.westpca.com/staff');
  // A top-level thin page groups under the root, which keeps its slash — and so
  // equals the home page's own canonical URL. scrapePersist must write both sets
  // of chunks in one call; see scrape-persist.test.js.
  assert.equal(getGroupUrl('https://www.westpca.com/about'), 'https://www.westpca.com/');
  // Query and hash never survive into a group URL.
  assert.equal(getGroupUrl('https://www.westpca.com/staff/kelly?utm_source=x#bio'), 'https://www.westpca.com/staff');
  // Unparseable input is handed back rather than throwing.
  assert.equal(getGroupUrl('not a url'), 'not a url');
});
