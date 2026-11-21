// Page chunk shape (LEO-147) — the two rules in services/chunkShape.js.
//
// Found on campcalvary.com/camps/mr/ (2026-11-14): two chunks of 482 and 855
// chars, because sections stop merging at CHUNK_TARGET (1200) even though the
// whole page fits under CHUNK_MAX (1800); and the page has no H1, so the
// schedule chunk's header was '[H2] Will Galkin' with nothing in it saying
// Men's Retreat.
//
// Both rules are measured here against the REAL extraction path — cheerio
// extractStructuredText, then the <title> fallback exactly as fetchPage applies
// it, then chunkText — so a change to any of the three fails this file. No DB,
// no network, no scrape.
//
// Fixture lengths are load-bearing and asserted: the MR page must land strictly
// between CHUNK_TARGET and CHUNK_MAX, or it would prove nothing. If those
// constants move, re-size the fixture rather than relaxing the assertions.

const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const { chunkText, extractStructuredText } = require('../src/services/scraper');
const {
  withTitleHeading,
  pageSubjectFromTitle,
  firstHeadingOf,
  mergeTargetFor,
  sectionLen,
} = require('../src/services/chunkShape');

const CHUNK_TARGET = 1200; // mirrors the scraper constants (not exported)
const CHUNK_MAX    = 1800;

// The extraction fetchPage performs: structured text, whitespace normalised, then
// the <title> → [H1] fallback. Mirrors services/scraper.js fetchPage.
function extract(html, url) {
  const $ = cheerio.load(html);
  $('nav, footer, script, style, noscript').remove();
  const text = extractStructuredText($, $('body')[0])
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return withTitleHeading(text, $('title').first().text(), url);
}

const MR_URL = 'https://campcalvary.com/camps/mr/';

// campcalvary.com/camps/mr/, reconstructed: no H1, an H2 for the retreat and an
// H2 for the speaker, the schedule under the speaker.
const MR_INTRO = 'Our annual Men\'s Retreat is a weekend away for men of every age to step out of the week\'s noise, hear the Word preached plainly, and eat more than is strictly wise. Registration includes two nights of lodging, five meals, and every session. Men come alone, with a friend, or with a whole small group, and nobody is ever the odd one out. The lodge sits on the far side of the lake, a ten minute walk from the dining hall, and the fire pit stays lit as late as anyone is willing to sit beside it.';
const MR_SPEAKER = 'Will Galkin serves as the teaching pastor of a congregation in the Lehigh Valley and has spoken at the retreat three times before. He preaches through whole books rather than topics, and he stays through Sunday lunch so the conversations started in a session can finish over a plate. This year he is teaching three sessions from the first half of Second Timothy, on what a man hands to the men who come after him.';
const MR_SCHEDULE = [
  'Friday 4:00 pm — check-in opens at the lodge',
  'Friday 6:00 pm — dinner in the dining hall',
  'Friday 7:30 pm — first session',
  'Saturday 8:00 am — breakfast',
  'Saturday 9:30 am — second session',
  'Saturday 12:00 pm — lunch, then free afternoon',
  'Saturday 6:00 pm — steak dinner',
  'Saturday 7:30 pm — third session',
  'Sunday 8:00 am — breakfast and departure',
];
const MR_HTML = `<!doctype html>
<html>
  <head><title>Men's Retreat – Camp Calvary</title></head>
  <body>
    <h2 id="mens-retreat">Men's Retreat</h2>
    <p>${MR_INTRO}</p>
    <h2 id="will-galkin">Will Galkin</h2>
    <p>${MR_SPEAKER}</p>
    <ul>${MR_SCHEDULE.map((l) => `<li>${l}</li>`).join('')}</ul>
  </body>
</html>`;

// ── rule 1: a page that fits under CHUNK_MAX stays one chunk ─────────────────

test('MR page: the fixture really does sit between CHUNK_TARGET and CHUNK_MAX', () => {
  const body = extract(MR_HTML, MR_URL)
    .split('\n')
    .filter((l) => !/^\[H1\]/.test(l))
    .join('\n');
  assert.ok(body.length > CHUNK_TARGET,
    `fixture must exceed CHUNK_TARGET to exercise the rule, got ${body.length}`);
  assert.ok(body.length <= CHUNK_MAX,
    `fixture must fit under CHUNK_MAX, got ${body.length}`);
});

test('MR page: one chunk, not one per H2', () => {
  const chunks = chunkText(extract(MR_HTML, MR_URL), MR_URL);
  assert.equal(chunks.length, 1, `expected a single chunk, got ${chunks.map((c) => c.content.length).join(' + ')}`);
  const [chunk] = chunks;
  // Both sections, and the schedule, are in the one chunk.
  assert.match(chunk.content, /Men's Retreat is a weekend away/);
  assert.match(chunk.content, /Will Galkin serves as the teaching pastor/);
  assert.match(chunk.content, /Saturday 7:30 pm/);
  assert.equal(chunk.chunkIndex, 0);
});

test('MR page: the header format the tests and dashboard read is unchanged', () => {
  const [chunk] = chunkText(extract(MR_HTML, MR_URL), MR_URL);
  const lines = chunk.content.split('\n');
  assert.equal(lines[0], `[Source: ${MR_URL}]`);
  assert.equal(lines[1], "[H1] Men's Retreat");
  assert.equal(lines[2], "[H2] Men's Retreat / Will Galkin");
  assert.equal(chunk.pageH1, "Men's Retreat");
  assert.equal(chunk.sectionH2, "Men's Retreat");
  assert.equal(chunk.sectionAnchor, 'mens-retreat');
  assert.ok(!/\[H[123]#/.test(chunk.content), 'no anchored marker may reach chunk text');
});

test('a page over CHUNK_MAX still splits — the rule is page-scoped, not a merge-everything', () => {
  const para = (n) => `${'Paragraph '.repeat(40)}number ${n}.`; // ~420 chars each
  const html = `<!doctype html><html><head><title>Big – Camp Calvary</title></head><body>
    <h1>Big Page</h1>
    <h2>One</h2><p>${para(1)}</p><p>${para(2)}</p>
    <h2>Two</h2><p>${para(3)}</p><p>${para(4)}</p>
    <h2>Three</h2><p>${para(5)}</p><p>${para(6)}</p>
  </body></html>`;
  const chunks = chunkText(extract(html, 'https://campcalvary.com/big/'), 'https://campcalvary.com/big/');
  assert.ok(chunks.length > 1, 'a page well over CHUNK_MAX must still be split');
  for (const c of chunks) assert.ok(c.content.length <= CHUNK_MAX + 200, `chunk of ${c.content.length} chars is far over CHUNK_MAX`);
});

test('mergeTargetFor: flushes as before over max, never flushes early under it', () => {
  const sec = (len, h2 = null) => ({ h2, anchor: null, paras: ['x'.repeat(len)] });
  const opts = { target: CHUNK_TARGET, max: CHUNK_MAX, url: MR_URL };
  assert.equal(mergeTargetFor([sec(482), sec(855)], opts), Infinity, 'a page under max is kept whole');
  assert.equal(mergeTargetFor([sec(900), sec(901)], opts), CHUNK_TARGET, 'a page over max keeps the old target');
  assert.equal(mergeTargetFor([], opts), Infinity);
  assert.equal(mergeTargetFor(null, opts), Infinity);
  // Exactly at max is still whole; one char past it is not.
  assert.equal(mergeTargetFor([sec(CHUNK_MAX)], opts), Infinity);
  assert.equal(mergeTargetFor([sec(CHUNK_MAX + 1)], opts), CHUNK_TARGET);
});

test('sectionLen measures what chunkText measures: paragraphs plus the heading line', () => {
  assert.equal(sectionLen({ h2: null, paras: ['abc', 'de'] }), 'abc\n\nde'.length);
  assert.equal(sectionLen({ h2: 'Hours', paras: ['abc'] }), 3 + 'Hours'.length + 10);
  assert.equal(sectionLen({}), 0);
  assert.equal(sectionLen(null), 0);
});

// ── rule 2: an H1-less page takes its subject from <title> ───────────────────

test('pageSubjectFromTitle: the site name is dropped from either side', () => {
  const url = 'https://campcalvary.com/camps/mr/';
  assert.equal(pageSubjectFromTitle("Men's Retreat – Camp Calvary", url), "Men's Retreat");
  assert.equal(pageSubjectFromTitle("Men's Retreat | Camp Calvary", url), "Men's Retreat");
  assert.equal(pageSubjectFromTitle("Camp Calvary | Men's Retreat", url), "Men's Retreat");
  assert.equal(pageSubjectFromTitle("Men's Retreat - Camp Calvary", url), "Men's Retreat");
  // A subdomain's site name is still the site name.
  assert.equal(pageSubjectFromTitle('Sourdough Loaf | Harvest Lane Farm',
    'https://shop.harvestlanefarm.com/product/sourdough'), 'Sourdough Loaf');
});

test('pageSubjectFromTitle: nothing to drop, nothing to split', () => {
  const url = 'https://campcalvary.com/camps/mr/';
  assert.equal(pageSubjectFromTitle("Men's Retreat", url), "Men's Retreat");
  assert.equal(pageSubjectFromTitle("  Men's   Retreat  ", url), "Men's Retreat");
  // A colon is not a separator — the subject is on the right of it.
  assert.equal(pageSubjectFromTitle("Camps: Men's Retreat", url), "Camps: Men's Retreat");
  // A hyphen inside a word is not a separator either.
  assert.equal(pageSubjectFromTitle('Pre-K Program – Camp Calvary', url), 'Pre-K Program');
  assert.equal(pageSubjectFromTitle('', url), null);
  assert.equal(pageSubjectFromTitle(null, url), null);
  assert.equal(pageSubjectFromTitle('   ', url), null);
  // No part survives the site-name filter: fall back to the first part.
  assert.equal(pageSubjectFromTitle('Camp Calvary | campcalvary', url), 'Camp Calvary');
  // Neither part matches the host: the common 'Page – Site' shape, first part wins.
  assert.equal(pageSubjectFromTitle('Summer Camp – Lititz Ministries', url), 'Summer Camp');
});

test('pageSubjectFromTitle: a keyword-stuffed title is clipped, not carried into every header', () => {
  const stuffed = `Men's Retreat ${'keyword '.repeat(40)}`.trim();
  const subject = pageSubjectFromTitle(stuffed, 'https://campcalvary.com/camps/mr/');
  assert.ok(subject.length <= 120, `expected a clipped subject, got ${subject.length} chars`);
  assert.match(subject, /^Men's Retreat/);
});

test('withTitleHeading: only ever adds an H1 to a page that has none', () => {
  const url = 'https://campcalvary.com/x/';
  const withH1 = '[H1] Real Heading\n\nSome body text that is long enough to keep.';
  assert.equal(withTitleHeading(withH1, 'Ignored – Camp Calvary', url), withH1, 'a real H1 is never overridden');
  const anchored = '[H1#top] Real Heading\n\nBody.';
  assert.equal(withTitleHeading(anchored, 'Ignored – Camp Calvary', url), anchored, 'an anchored H1 counts as an H1');
});

test('withTitleHeading: an empty render stays empty — the crawl reads that as a failed page', () => {
  const url = 'https://campcalvary.com/x/';
  assert.equal(withTitleHeading('', 'Men\'s Retreat – Camp Calvary', url), '');
  assert.equal(withTitleHeading('   \n  ', "Men's Retreat – Camp Calvary", url).trim(), '');
  assert.equal(withTitleHeading(null, "Men's Retreat – Camp Calvary", url), '');
});

test('withTitleHeading: with no usable title, the first heading on the page is the subject', () => {
  const url = 'https://campcalvary.com/camps/mr/';
  const body = '[H2#mens-retreat] Men\'s Retreat\n\nA weekend away for men of every age.';
  assert.equal(withTitleHeading(body, '', url), `[H1] Men's Retreat\n\n${body}`);
  // Nothing at all to take a subject from: unchanged, no empty [H1] line.
  const bare = 'Just a paragraph with no heading anywhere on the page.';
  assert.equal(withTitleHeading(bare, '', url), bare);
  assert.equal(firstHeadingOf(bare), null);
  assert.equal(firstHeadingOf('[H3] Third Level\n\nBody.'), 'Third Level');
});

test('H1-less MR page: every chunk carries the page subject in its header', () => {
  // Two long sections so the page splits — the point is that BOTH halves say
  // Men's Retreat, which is what the 482/855 split failed to do.
  const filler = `${'This is the body of the section. '.repeat(30)}`;
  const html = `<!doctype html>
    <html><head><title>Men's Retreat – Camp Calvary</title></head><body>
      <h2 id="mens-retreat">Men's Retreat</h2><p>${filler}</p><p>${filler}</p>
      <h2 id="will-galkin">Will Galkin</h2><p>${filler}</p><p>${filler}</p>
    </body></html>`;
  const chunks = chunkText(extract(html, MR_URL), MR_URL);
  assert.ok(chunks.length > 1, 'fixture must split to prove every chunk carries the subject');
  for (const c of chunks) {
    assert.equal(c.pageH1, "Men's Retreat");
    assert.match(c.content, /^\[Source: https:\/\/campcalvary\.com\/camps\/mr\/\]\n\[H1\] Men's Retreat\n/);
  }
});

test('a page that has its own H1 is untouched end to end', () => {
  const html = `<!doctype html><html><head><title>Services – Burk Digital</title></head><body>
    <h1>Burk Digital</h1>
    <h2>Services</h2><p>We build websites and brand identities for small businesses that need to look credible.</p>
  </body></html>`;
  const url = 'https://burkdigital.com/services';
  const [chunk] = chunkText(extract(html, url), url);
  assert.equal(chunk.pageH1, 'Burk Digital');
  assert.match(chunk.content, /\[H1\] Burk Digital/);
  assert.ok(!chunk.content.includes('[H1] Services'), 'the <title> must not displace a real H1');
});
