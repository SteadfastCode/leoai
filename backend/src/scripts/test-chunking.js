// Chunking regression harness (LEO-032).
//
// LEO-032 widened the [H1]/[H2]/[H3] markers to carry the heading's DOM id
// ([H2#the-id] Title). Four separate consumers matched those markers with their own
// literal regex — keepPara, the chunkText H1/H2 split, buildGroupChunks, and the
// Puppeteer hasH1 trigger. Missing one would not throw; it would silently mislabel
// chunks for every entity on the next nightly LeoRefresh, which is undetectable
// without exactly this kind of fixture comparison.
//
// So the assertions are deliberately blunt: for a set of committed static HTML
// fixtures, chunk count, label, sectionH2 and pageH1 must be BYTE-IDENTICAL to the
// values recorded before the change, and content length must not move by a single
// character. Only sectionAnchor is new.
//
// The baseline below was captured by running this exact pipeline against these exact
// fixtures on the pre-LEO-032 code. Do NOT regenerate it to make a failing test pass —
// a diff here means chunking behaviour changed, which is the thing being guarded.
//
// Runs under `node --test` (matched by the test-*.js pattern). No DB, no network,
// and deliberately NO real scrape.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');

const { chunkText, extractStructuredText } = require('../services/scraper');

const FIXTURE_DIR = path.join(__dirname, '../../test/fixtures/chunking');

// Captured from the pre-LEO-032 implementation. contentLen is included on purpose:
// the first cut of this change leaked "#accessibility" into an [H3] body marker and
// grew this chunk by exactly 14 characters. Nothing else caught it.
const BASELINE = {
  'hours.html': [
    { label: 'Location & Parking', sectionH2: 'Location & Parking', pageH1: 'Dosie Dough Bakery', contentLen: 650, chunkIndex: 0 },
  ],
  'no-h1.html': [
    { label: 'Seasonal Menu', sectionH2: 'Seasonal Menu', pageH1: null, contentLen: 241, chunkIndex: 0 },
  ],
  'no-ids.html': [
    { label: 'Services', sectionH2: 'Services', pageH1: 'Burk Digital', contentLen: 501, chunkIndex: 0 },
  ],
  'tricky-ids.html': [
    { label: 'Our Values & Beliefs', sectionH2: 'Our Values & Beliefs', pageH1: 'About Our Team', contentLen: 509, chunkIndex: 0 },
  ],
};

// Anchor expected per fixture chunk. null where the heading carried no id — an absent
// id must produce null, never '' or 'undefined', because those would serialise into a
// broken "page#" deep link.
const EXPECTED_ANCHORS = {
  'hours.html': ['location'],
  'no-h1.html': ['menu'],
  'no-ids.html': [null],
  'tricky-ids.html': ['section--with--dashes'],
};

function chunksFor(fixture) {
  const html = fs.readFileSync(path.join(FIXTURE_DIR, fixture), 'utf8');
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const text = extractStructuredText($, 'body');
  return chunkText(text, `https://example.com/${fixture.replace('.html', '')}`);
}

for (const fixture of Object.keys(BASELINE)) {
  test(`${fixture} — chunk shape is byte-identical to the pre-LEO-032 baseline`, () => {
    const actual = chunksFor(fixture).map((c) => ({
      label: c.label,
      sectionH2: c.sectionH2,
      pageH1: c.pageH1,
      contentLen: c.content.length,
      chunkIndex: c.chunkIndex,
    }));
    assert.deepEqual(actual, BASELINE[fixture]);
  });

  test(`${fixture} — sectionAnchor is populated where the fixture has ids`, () => {
    const anchors = chunksFor(fixture).map((c) => c.sectionAnchor);
    assert.deepEqual(anchors, EXPECTED_ANCHORS[fixture]);
    for (const a of anchors) {
      assert.ok(a === null || (typeof a === 'string' && a.length > 0),
        `anchor must be null or a non-empty string, got ${JSON.stringify(a)}`);
    }
  });
}

test('heading anchors never leak into chunk body text', () => {
  // The [H3] marker survives in body text; its #anchor must not. A leak here changes
  // the embedded string, so every previously-scraped page would re-embed on rescrape.
  const content = chunksFor('hours.html')[0].content;
  assert.match(content, /\[H3\] Accessibility/);
  assert.ok(!content.includes('#accessibility'), 'anchor leaked into body text');
  assert.ok(!/\[H[123]#/.test(content), 'no chunk content may carry an anchored marker');
});

test('page-level H1 text excludes its anchor', () => {
  const chunk = chunksFor('hours.html')[0];
  assert.equal(chunk.pageH1, 'Dosie Dough Bakery');
  assert.match(chunk.content, /\[H1\] Dosie Dough Bakery/);
});
