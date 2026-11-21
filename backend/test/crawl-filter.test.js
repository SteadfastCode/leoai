// Non-content URL rules at enqueue, and the near-empty chunk drop (LEO-136).
//
// Everything here is pure — no site is contacted and no chunk is embedded. The
// URLs are the real ones from the 2026-11-14 scrape audit (harvestlanefarmmarket.com,
// shop.harvestlanefarmmarket.com, gbclancaster.org) and the chunk bodies are
// copied from what /api/admin/search returned for those domains, so a rule that
// stops matching the shape of the real data fails here.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_CHUNK_BODY,
  classifyCrawlUrl,
  crawlableUrl,
  stripTrackingParams,
  chunkBody,
  isNearEmptyChunk,
  dropNearEmptyChunks,
} = require('../src/services/crawlFilter');

// Logging is a side effect on console.log; keep the test output readable.
process.env.CRAWL_FILTER_LOG_LEVEL = 'off';

// ── One test per skip rule, with a URL the audit actually found ────────────

const SKIPPED = [
  ['cart',       'https://gbclancaster.org/cart'],
  ['cart',       'https://harvestlanefarmmarket.com/cart/'],
  ['checkout',   'https://harvestlanefarmmarket.com/checkout/'],
  ['account',    'https://harvestlanefarmmarket.com/my-account/'],
  ['account',    'https://shop.harvestlanefarmmarket.com/account/orders'],
  ['auth',       'https://harvestlanefarmmarket.com/login/?redirect_to=%2F'],
  ['auth',       'https://harvestlanefarmmarket.com/register'],
  ['search',     'https://harvestlanefarmmarket.com/search?q=jam'],
  ['taxonomy',   'https://harvestlanefarmmarket.com/tag/bread/'],
  ['taxonomy',   'https://gbclancaster.org/tags/sermons/'],
  ['taxonomy',   'https://harvestlanefarmmarket.com/product-tag/jam/'],
  ['taxonomy',   'https://gbclancaster.org/category/announcements/'],
  ['taxonomy',   'https://gbclancaster.org/author/admin/'],
  ['feed',       'https://gbclancaster.org/feed/'],
  ['feed',       'https://gbclancaster.org/blog/feed'],
  ['api',        'https://harvestlanefarmmarket.com/wp-json/wp/v2/pages'],
  ['pagination', 'https://gbclancaster.org/blog/page/2/'],
  ['pagination', 'https://harvestlanefarmmarket.com/page/13'],
  ['asset',      'https://harvestlanefarmmarket.com/wp-content/uploads/2026/04/market.jpg'],
  ['asset',      'https://gbclancaster.org/wp-content/uploads/sermon-2026-11-16.mp3'],
  ['asset',      'https://harvestlanefarmmarket.com/downloads/press-kit.zip'],
  ['query',      'https://harvestlanefarmmarket.com/shop/?add-to-cart=2562'],
  ['query',      'https://gbclancaster.org/about/?format=json-pretty'],
  ['query',      'https://gbclancaster.org/sermon/grace/?replytocom=51'],
  ['fragment',   'https://gbclancaster.org/sermon/grace/#respond'],
];

for (const [rule, url] of SKIPPED) {
  test(`rule ${rule} skips ${url}`, () => {
    const got = classifyCrawlUrl(url);
    assert.equal(got.url, null, `${url} should not be queued`);
    assert.equal(got.rule, rule);
    assert.equal(crawlableUrl(url), null);
  });
}

// ── What must stay crawlable ──────────────────────────────────────────────

// The item is explicit: a shop's catalogue pages are out of scope here. If one
// of these ever starts being skipped, a real page has gone missing from a KB.
const KEPT = [
  'https://harvestlanefarmmarket.com/',
  'https://harvestlanefarmmarket.com/product/strawberry-jam/',
  'https://harvestlanefarmmarket.com/product-category/our-own-prepared-goods/',
  'https://shop.harvestlanefarmmarket.com/product/-our-own-canned-goods-gift-basket/2562',
  'https://harvestlanefarmmarket.com/about-us/',
  'https://harvestlanefarmmarket.com/hours',
  'https://gbclancaster.org/what-we-believe/',
  'https://gbclancaster.org/sermons/',
  // A document is parsed (pdf) or followed one hop (docx) — never an 'asset'.
  'https://gbclancaster.org/wp-content/uploads/bulletin.pdf',
  'https://gbclancaster.org/wp-content/uploads/newsletter.docx',
  // A segment that merely CONTAINS a skip word is a real page.
  'https://harvestlanefarmmarket.com/golf-cart-rentals/',
  'https://harvestlanefarmmarket.com/categories-of-produce/',
  'https://gbclancaster.org/page/',
  // Pagination is /page/<n>, not an arbitrary trailing number.
  'https://gbclancaster.org/blog/2026/11/',
];

for (const url of KEPT) {
  test(`stays crawlable: ${url}`, () => {
    const got = classifyCrawlUrl(url);
    assert.equal(got.rule, null);
    assert.equal(got.url, url);
  });
}

// ── Tracking parameters are stripped, never skipped ───────────────────────

test("Square's navigation query string is stripped and the product page still queued", () => {
  const url = 'https://shop.harvestlanefarmmarket.com/product/-our-own-canned-goods-gift-basket/2562?cp=true&sa=false&sbp=false&q=false&category_id=DKVM4D2LPSVG3JS3ONEUDFTK';
  const got = classifyCrawlUrl(url);
  assert.equal(got.rule, null, 'a real product page must not be skipped for its query string');
  assert.equal(got.url, 'https://shop.harvestlanefarmmarket.com/product/-our-own-canned-goods-gift-basket/2562');
  assert.deepEqual(got.stripped.sort(), ['category_id', 'cp', 'q', 'sa', 'sbp']);
});

test('utm_* and ad-network tags are stripped', () => {
  const { url, stripped } = stripTrackingParams(
    'https://gbclancaster.org/visit/?utm_source=fb&utm_medium=cpc&fbclid=IwAR123&gclid=abc'
  );
  assert.equal(url, 'https://gbclancaster.org/visit/');
  assert.deepEqual(stripped.sort(), ['fbclid', 'gclid', 'utm_medium', 'utm_source']);
});

test('a parameter that is not tracking is left alone', () => {
  const url = 'https://harvestlanefarmmarket.com/events/?month=2026-12';
  assert.deepEqual(stripTrackingParams(url), { url, stripped: [] });
  assert.equal(crawlableUrl(url), url);
});

test('a mixed query keeps the meaningful parameter and loses the tracking one', () => {
  const { url, stripped } = stripTrackingParams('https://harvestlanefarmmarket.com/events/?month=2026-12&utm_source=newsletter');
  assert.equal(url, 'https://harvestlanefarmmarket.com/events/?month=2026-12');
  assert.deepEqual(stripped, ['utm_source']);
});

test('an unparseable URL is returned untouched rather than lost', () => {
  for (const bad of ['not a url', '', 'http://']) {
    const got = classifyCrawlUrl(bad);
    assert.equal(got.rule, null);
    assert.equal(got.url, bad);
  }
});

// ── Near-empty chunks ─────────────────────────────────────────────────────

// Verbatim from /api/admin/search on harvestlanefarmmarket.com, 2026-11-21.
const ADD_TO_CART_CHUNK =
  '[Source: https://harvestlanefarmmarket.com/product-category/our-own-prepared-goods/]\n[H1] Shop Our Market Online\n\n95 Add to cart';

const EMPTY_GROUP_CHUNK =
  '[Source: https://shop.harvestlanefarmmarket.com/product/-thinking-of-you-gift-basket/]\n\n\n\n[Source: https://shop.harvestlanefarmmarket.com/product/-thinking-of-you-gift-basket/2267?cp=true&sa=false&sbp=false&q=false&category_id=DKVM4D2LPSVG3JS3ONEUDFTK]';

const REAL_GROUP_CHUNK =
  "[Source: https://shop.harvestlanefarmmarket.com/product/-our-own-canned-goods-basket/]\n\n\n\n[Source: https://shop.harvestlanefarmmarket.com/product/-our-own-canned-goods-basket/2562]\n[H1] 'Our Own Canned Goods' Gift Basket\n\n[H3] $57.95\n\nThis item has a prep time of 1 business day. It may change when your order is available.\n\n851 E Oregon Rd Lititz, PA\n\nA variety of our own canned goods";

test("the '95 Add to cart' chunk measures 14 chars of body and is dropped", () => {
  assert.equal(chunkBody(ADD_TO_CART_CHUNK), '95 Add to cart');
  assert.equal(isNearEmptyChunk(ADD_TO_CART_CHUNK), true);
});

test('a group chunk whose only card rendered no text at all is dropped', () => {
  // Its 300-odd characters are two URLs — nothing a visitor could be told.
  assert.equal(chunkBody(EMPTY_GROUP_CHUNK), '');
  assert.equal(isNearEmptyChunk(EMPTY_GROUP_CHUNK), true);
});

test('a group chunk with a real product card is kept', () => {
  assert.equal(isNearEmptyChunk(REAL_GROUP_CHUNK), false);
  assert.match(chunkBody(REAL_GROUP_CHUNK), /^\[H1\] 'Our Own Canned Goods' Gift Basket/);
});

test("a staff group chunk whose cards are only names and emails is kept (LEO-083 must not regress)", () => {
  const staff = [
    '[Source: https://gbclancaster.org/staff/]',
    '',
    '[Source: https://gbclancaster.org/staff/kelly-robinson/]',
    '[H1] Kelly Robinson',
    '',
    'kelly@gbclancaster.org',
    '',
    '[Source: https://gbclancaster.org/staff/mark-webb/]',
    '[H1] Mark Webb',
    '',
    'mark@gbclancaster.org',
  ].join('\n');
  assert.equal(isNearEmptyChunk(staff), false);
  // Every card's own H1 counts as body — only the leading header block does not.
  assert.match(chunkBody(staff), /Kelly Robinson/);
  assert.match(chunkBody(staff), /Mark Webb/);
});

test('a normal chunk with a real paragraph is kept', () => {
  const chunk = [
    '[Source: https://gbclancaster.org/what-we-believe/]',
    '[H1] What We Believe',
    '[H2] Scripture',
    '',
    'We hold the Scriptures of the Old and New Testaments to be the inspired and inerrant word of God.',
  ].join('\n');
  assert.equal(isNearEmptyChunk(chunk), false);
  assert.equal(chunkBody(chunk).startsWith('We hold the Scriptures'), true);
});

test('the boundary is MIN_CHUNK_BODY chars of body', () => {
  const header = '[Source: https://example.com/x]\n[H1] Title\n\n';
  assert.equal(isNearEmptyChunk(header + 'a'.repeat(MIN_CHUNK_BODY - 1)), true);
  assert.equal(isNearEmptyChunk(header + 'a'.repeat(MIN_CHUNK_BODY)), false);
});

test('dropNearEmptyChunks keeps order and leaves the kept chunks untouched', () => {
  const keep1 = { content: REAL_GROUP_CHUNK, url: 'a', chunkIndex: 0 };
  const drop  = { content: ADD_TO_CART_CHUNK, url: 'b', chunkIndex: 1 };
  const keep2 = { content: EMPTY_GROUP_CHUNK.replace(/$/, '\n\nOpen Tuesday through Saturday, 8am to 6pm.'), url: 'c', chunkIndex: 2 };
  const out = dropNearEmptyChunks([keep1, drop, keep2]);
  assert.deepEqual(out, [keep1, keep2]);
});

test('dropNearEmptyChunks tolerates junk input', () => {
  assert.deepEqual(dropNearEmptyChunks(null), []);
  assert.deepEqual(dropNearEmptyChunks([{ url: 'x' }]), []);
  assert.deepEqual(dropNearEmptyChunks([{ content: null }]), []);
});
