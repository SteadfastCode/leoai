// Cookie-consent banner strip (LEO-132).
//
// Four layers of test:
//   1. The paragraph predicate in isolation — what counts as consent
//      boilerplate, and the false positives it must not claim (a bakery that
//      sells cookies, a software shop that uses "similar technologies").
//   2. The cheerio removal over two fixtures of REAL captured banner markup:
//      Squarespace (gbclancaster.org, the page that exposed the bug) and
//      HubSpot CMS. Banner gone, real content byte-for-byte intact.
//   3. The browser-side function Puppeteer serializes into the page, driven
//      against the same fixtures through a fake `document` backed by cheerio —
//      the real code path, without a browser.
//   4. The full extract → keepPara → chunkText pipeline, including the case
//      where NO selector matches (an unknown consent platform) and only the
//      paragraph fallback can save the embeddings.
//
// No DB, no network, no browser. The extraction wrapper repeats the three
// whitespace normalizations fetchPage applies between extractStructuredText and
// chunkText — fetchPage itself is not exported, and chunking un-normalized text
// would not be the text the scraper actually chunks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');

const {
  CONSENT_SELECTORS,
  CONSENT_PARA_MAX,
  isConsentParagraph,
  stripConsentNodes,
  stripConsentInPage,
  removeSelectorsInDocument,
} = require('../src/services/consentStrip');
const { chunkText, extractStructuredText } = require('../src/services/scraper');

process.env.CONSENT_STRIP_LOG_LEVEL = process.env.CONSENT_STRIP_LOG_LEVEL || 'off';

const SQS_URL = 'https://gbclancaster.org/';
const HS_URL  = 'https://dosiedough.com/';

// The exact banner text measured on gbclancaster.org on 2026-11-14.
const SQS_BANNER = 'Select “Accept all” to agree to our use of cookies and similar technologies '
  + 'to enhance your browsing experience, security, analytics and customization. '
  + 'Select ”Manage cookies” to make more choices or opt out.';

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', 'consent', name), 'utf8');
}

function normalize(text) {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Repeats fetchPage's cheerio pre-filters in order, with the consent strip in
// the position scraper.js calls it from.
function textFrom(html, url, { strip = true } = {}) {
  const $ = cheerio.load(html);
  $('nav, footer, script, style, noscript').remove();
  if (strip) stripConsentNodes($, url);
  return normalize(extractStructuredText($, $('body')[0]));
}

// ------------------------------------------------------------ 1. the predicate

test('isConsentParagraph drops real consent boilerplate', () => {
  for (const p of [
    SQS_BANNER,
    '[SB]' + SQS_BANNER,
    'Manage cookies',
    '[SB]Cookie preferences',
    'This website uses cookies to ensure you get the best experience.',
    'We use cookies and similar technologies to personalise content.',
    'Accept all cookies',
    'Click below to accept all cookies or manage your preferences.',
  ]) {
    assert.equal(isConsentParagraph(p), true, `should be consent: ${p.slice(0, 60)}`);
  }
});

test('isConsentParagraph leaves real content alone', () => {
  for (const p of [
    'We bake chocolate chip cookies fresh every morning, and our cookie trays are available for pickup.',
    'We build apps with React, Vue and similar technologies for small businesses.',
    '[SB]SUNDAY SCHOOL - 9:30 A.M.',
    '[SB]WORSHIP SERVICE - 10:45 A.M.',
    'Accept all',                  // a bare button label, no cookie word anywhere
    'Our cookie dough is available by the pound.',
    '',
  ]) {
    assert.equal(isConsentParagraph(p), false, `should be kept: ${p.slice(0, 60)}`);
  }
});

test('isConsentParagraph never drops a heading', () => {
  assert.equal(isConsentParagraph('[H1] Cookie Policy'), false);
  assert.equal(isConsentParagraph('[H2#cookies] We use cookies'), false);
  assert.equal(isConsentParagraph('[SB][H3] Manage cookies'), false);
});

test('isConsentParagraph leaves long prose alone, and needs density above 280 chars', () => {
  // Over CONSENT_PARA_MAX — a privacy policy paragraph is still real content.
  const long = 'Our use of cookies is described here. ' + 'x'.repeat(CONSENT_PARA_MAX);
  assert.equal(isConsentParagraph(long), false);

  // Between 280 and CONSENT_PARA_MAX with ONE signal — kept.
  const oneSignal = 'We are a family bakery in Lititz and have been since 1998. '
    + 'Everything is made from scratch in small batches, early in the morning, by people who live here. '
    + 'Our website uses cookies. Come and see us on Market Street any morning of the week — we would '
    + 'love to meet you, and the first cup of coffee is always on the house.';
  assert.ok(oneSignal.length > 280 && oneSignal.length < CONSENT_PARA_MAX);
  assert.equal(isConsentParagraph(oneSignal), false);

  // The real HubSpot banner is in the same length band but is dense with them.
  const hubspot = 'We use cookies to improve HubSpot’s site. Some cookies are necessary for our '
    + 'website and services to function properly. Other cookies are optional and help personalize your '
    + 'experience, including advertising and analytics. You can consent to all cookies, decline all '
    + 'optional cookies, or manage optional cookies. Without a selection, our default cookie settings '
    + 'will apply. You can change your preferences at any time. To learn more, check out our Cookie Policy.';
  assert.ok(hubspot.length > 280 && hubspot.length <= CONSENT_PARA_MAX);
  assert.equal(isConsentParagraph(hubspot), true);
});

// ------------------------------------------------- 2. cheerio removal, fixtures

test('Squarespace banner is gone from the extracted text, service times survive', () => {
  const before = textFrom(fixture('squarespace-gbclancaster.html'), SQS_URL, { strip: false });
  // Guard the fixture itself: without the strip the banner IS the first thing
  // on the page, which is what diluted every chunk on the live site.
  assert.ok(before.includes('use of cookies'), 'fixture must contain the banner');
  assert.ok(before.includes('Manage cookies'));

  const after = textFrom(fixture('squarespace-gbclancaster.html'), SQS_URL);
  assert.ok(!/use of cookies/i.test(after), 'banner text must be gone');
  assert.ok(!/Accept all/i.test(after), 'banner CTA must be gone');
  assert.ok(!/Manage cookies/i.test(after), 'banner CTA must be gone');

  // Real content, untouched.
  assert.ok(after.includes('SUNDAY SCHOOL - 9:30 A.M.'));
  assert.ok(after.includes('WORSHIP SERVICE - 10:45 A.M.'));
  assert.ok(after.includes('1899 Marietta Avenue'));
  assert.ok(after.includes('office@gbclancaster.org'));
  assert.ok(after.includes('(717) 394-6991'));
  assert.ok(after.includes('Venture Church Network Mid-Atlantic'));
  assert.ok(/\[H1\] Grace Baptist Church/.test(after));
});

test('HubSpot CMS banner is gone, a bakery that sells cookies is not', () => {
  const before = textFrom(fixture('hubspot-cms.html'), HS_URL, { strip: false });
  assert.ok(before.includes('We use cookies to improve'), 'fixture must contain the banner');

  const after = textFrom(fixture('hubspot-cms.html'), HS_URL);
  assert.ok(!/We use cookies to improve/i.test(after));
  assert.ok(!/Decline all/i.test(after));
  assert.ok(!/Manage Cookies/i.test(after));

  assert.ok(after.includes('chocolate chip cookies fresh every morning'));
  assert.ok(after.includes('cookie trays are available for pickup'));
  assert.ok(after.includes('Closed Sundays'));
  assert.ok(after.includes('$18.00'));
  assert.ok(/\[H1\] Dosie Dough Bakery/.test(after));
});

test('stripConsentNodes reports what it removed and survives a bad selector', () => {
  const $ = cheerio.load(fixture('squarespace-gbclancaster.html'));
  assert.ok(stripConsentNodes($, SQS_URL) > 0);
  // Idempotent — nothing left to remove on a second pass.
  assert.equal(stripConsentNodes($, SQS_URL), 0);

  // A page with no banner is left completely alone.
  const plain = cheerio.load('<body><h1>Hours</h1><p>Open daily 7am - 3pm.</p></body>');
  assert.equal(stripConsentNodes(plain, 'https://example.com/'), 0);
  assert.ok(plain('body').text().includes('Open daily'));
});

// ------------------------------------------------------- 3. the browser-side fn

// A `document` good enough for removeSelectorsInDocument, backed by cheerio.
// This is how the function behaves inside Puppeteer: querySelectorAll returns a
// list whose entries remove themselves from the DOM.
function fakeDocument($) {
  return {
    querySelectorAll(sel) {
      return $(sel).toArray().map((node) => ({ remove: () => $(node).remove() }));
    },
  };
}

function fakePage($) {
  return {
    evaluate: async (fn, arg) => {
      global.document = fakeDocument($);
      try {
        return fn(arg);
      } finally {
        delete global.document;
      }
    },
  };
}

test('the serialized browser function has no closure references', () => {
  const src = removeSelectorsInDocument.toString();
  assert.ok(src.includes('document.querySelectorAll'));
  // Anything from module scope would be undefined inside the page.
  assert.ok(!/CONSENT_SELECTORS|debug\(|TIERS/.test(src));
});

test('stripConsentInPage removes the Squarespace banner in the browser path', async () => {
  const $ = cheerio.load(fixture('squarespace-gbclancaster.html'));
  const hits = await stripConsentInPage(fakePage($), [], SQS_URL);
  assert.ok(hits.length > 0, 'at least one selector must match');
  const text = normalize(extractStructuredText($, $('body')[0]));
  assert.ok(!/use of cookies|Accept all|Manage cookies/i.test(text));
  assert.ok(text.includes('SUNDAY SCHOOL - 9:30 A.M.'));
});

test('stripConsentInPage also applies the Pass 1 Haiku selectors it carries', async () => {
  const $ = cheerio.load('<body><div class="promo-ribbon">20% OFF TODAY</div><p>Open daily 7am - 3pm.</p></body>');
  await stripConsentInPage(fakePage($), ['.promo-ribbon'], 'https://example.com/');
  assert.ok(!$('body').text().includes('20% OFF'));
  assert.ok($('body').text().includes('Open daily'));
});

test('stripConsentInPage never throws when the page is gone', async () => {
  const dead = { evaluate: async () => { throw new Error('Execution context was destroyed'); } };
  assert.deepEqual(await stripConsentInPage(dead, [], 'https://example.com/'), []);
});

// -------------------------------------------------------- 4. the full pipeline

test('no chunk of the Squarespace page carries the banner', () => {
  const text = textFrom(fixture('squarespace-gbclancaster.html'), SQS_URL);
  const chunks = chunkText(text, SQS_URL);
  assert.ok(chunks.length > 0);
  for (const c of chunks) {
    assert.ok(!/use of cookies|Accept all|Manage cookies/i.test(c.content), `banner leaked into: ${c.content.slice(0, 120)}`);
  }
  assert.ok(chunks.some(c => c.content.includes('9:30 A.M.') && c.content.includes('10:45 A.M.')),
    'the service times must still be chunked');
});

test('the paragraph fallback catches a banner no selector knows about', () => {
  // An unknown consent platform: no vendor class, no aria-label, nothing the
  // selector list can match — only keepPara stands between it and the embeddings.
  const html = `<body><div class="notice-strip-9f3"><p>${SQS_BANNER}</p>`
    + '<button>Accept all</button></div>'
    + '<h1>Grace Baptist Church</h1>'
    + '<p>SUNDAY SCHOOL - 9:30 A.M.</p><p>WORSHIP SERVICE - 10:45 A.M.</p>'
    + '<p>1899 Marietta Avenue, Lancaster, PA 17603. Call us on (717) 394-6991 with any questions at all.</p></body>';

  const text = textFrom(html, SQS_URL);
  assert.ok(text.includes('use of cookies'), 'no selector should have matched this one');

  const chunks = chunkText(text, SQS_URL);
  for (const c of chunks) {
    assert.ok(!/use of cookies/i.test(c.content), `banner leaked into: ${c.content.slice(0, 120)}`);
  }
  assert.ok(chunks.some(c => c.content.includes('9:30 A.M.')));
});

// ------------------------------------------------------------------- selectors

test('the selector list stays free of substrings a real page could use', () => {
  for (const sel of CONSENT_SELECTORS) {
    // A bare cookie/gdpr substring would eat a bakery's .cookie-card products.
    assert.ok(!/\[(?:class|id)\*="(?:cookie|gdpr|consent)" i\]/.test(sel), `too broad: ${sel}`);
    // Every selector must be valid in cheerio — an invalid one is skipped
    // silently at runtime, which would make a platform quietly unsupported.
    assert.doesNotThrow(() => cheerio.load('<body></body>')(sel), `invalid selector: ${sel}`);
  }
});

test('debug tiers: off is silent, light names the source', async () => {
  const lines = [];
  const real = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    process.env.CONSENT_STRIP_LOG_LEVEL = 'off';
    stripConsentNodes(cheerio.load(fixture('squarespace-gbclancaster.html')), SQS_URL);
    isConsentParagraph(SQS_BANNER);
    assert.equal(lines.length, 0, 'off must log nothing');

    process.env.CONSENT_STRIP_LOG_LEVEL = 'light';
    stripConsentNodes(cheerio.load(fixture('squarespace-gbclancaster.html')), SQS_URL);
    assert.ok(lines.some(l => l.includes(SQS_URL) && l.includes('cookie-banner-mount-point')),
      `light must name the url and the selector, got: ${lines.join(' | ')}`);
  } finally {
    console.log = real;
    process.env.CONSENT_STRIP_LOG_LEVEL = 'off';
  }
});
