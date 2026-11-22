// Site-wide boilerplate strip (LEO-141).
//
// Driven against a FIXTURE SITE — ten pages of extracted text in exactly the
// shape fetchPage hands to the chunker ([H1]/[H2] markers, [SB] block markers,
// blank-line-separated paragraphs). The site carries, on every page:
//   - a reCAPTCHA notice (the harvestlanefarmmarket.com case, 139 chunks)
//   - a footer address + service-times block (the gbclancaster.org case — the
//     block that must survive the strip, because it is the only place on the
//     site those times appear)
//   - a Squarespace consent banner (LEO-132's case, which must be stripped and
//     must NOT be promoted into the 'Site-wide info' chunk)
// and, on exactly two pages, one staff member's bio — the per-person-bio
// regression 0a0ab27 fixed, which must not come back.
//
// No DB, no network, no browser: the embedding call is injected.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChromeTracker,
  isBoilerplate,
  buildSiteWideContent,
  siteWideUrlFor,
  cachedStructure,
  chromeUpdate,
  fingerprint,
  eligible,
  MIN_SITE_PAGES,
  PASS1_MAX_AGE_DAYS,
} = require('../src/services/boilerplate');

const { chunkText, buildGroupChunks } = require('../src/services/scraper');

const RECAPTCHA = 'This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.';
const FOOTER = 'Grace Baptist Church · 123 Lititz Pike, Lancaster, PA 17601 · (717) 555-0142 · Sunday worship 9:30 AM and 10:45 AM';
const CONSENT = 'Select “Accept all” to agree to our use of cookies and similar technologies to enhance your browsing experience, security, analytics and customization. Select ”Manage cookies” to make more choices or opt out.';
const NAV = 'Home About Ministries Sermons Events Give Contact';
const BIO = 'Pastor Kelly Robinson has served Grace Baptist since 2011. He studied at Westminster and spends his free time restoring a 1962 tractor with his three sons.';

/** One page of the fixture site, chrome included, in extracted-text shape. */
function page(url, body, extra = []) {
  return {
    url,
    text: [CONSENT, NAV, ...body, ...extra, RECAPTCHA, `[SB]${FOOTER}`].join('\n\n'),
  };
}

function fixtureSite() {
  const topics = [
    ['[H1] Welcome to Grace Baptist', 'We are a church family in Lancaster County that loves to open the Scriptures together every week and to welcome anyone who walks in the door.'],
    ['[H1] About Us', 'Grace Baptist was planted in 1974 by a handful of families meeting in a living room on East King Street, and we have met on the same corner ever since.'],
    ['[H1] Ministries', 'Our childrens ministry, youth group, mens and womens studies and the Tuesday night prayer meeting all run through the school year.'],
    ['[H1] Sermons', 'Every Sunday message is recorded and posted here within a day, going back to the spring of 2008 when we started recording them.'],
    ['[H1] Events', 'The church calendar covers the fall picnic, the Christmas concert, the Good Friday service and the summer day camp for grade schoolers.'],
    ['[H1] Giving', 'Offerings can be dropped in the box at the back of the sanctuary or given online, and the deacons publish a quarterly summary of where it went.'],
    ['[H1] Contact', 'The church office is open Tuesday through Friday and the quickest way to reach anyone is the phone number in the footer of this page.'],
    ['[H1] Beliefs', 'We hold to the Trinity, the authority of Scripture, the bodily resurrection of Christ and salvation by grace through faith alone.'],
  ];
  const pages = topics.map(([h1, body], i) => page(`https://gbc.test/p${i}`, [h1, body]));
  // The bio lives on the staff listing AND on its own detail page — two pages.
  pages.push(page('https://gbc.test/staff', ['[H1] Our Staff', BIO]));
  pages.push(page('https://gbc.test/staff/kelly-robinson', ['[H1] Kelly Robinson', BIO]));
  return pages;
}

test('a block on most pages of the fixture site is detected; a two-page bio is not', () => {
  const chrome = createChromeTracker({ baseUrl: 'https://gbc.test', domain: 'gbc.test' });
  chrome.note(fixtureSite());
  const report = chrome.report();

  assert.equal(report.pageCount, 10);
  assert.ok(report.fingerprints.includes(fingerprint(RECAPTCHA)), 'reCAPTCHA notice is site-wide');
  assert.ok(report.fingerprints.includes(fingerprint(FOOTER)), 'footer block is site-wide');
  assert.ok(report.fingerprints.includes(fingerprint(NAV)), 'rendered nav text is site-wide');
  assert.ok(!report.fingerprints.includes(fingerprint(BIO)), 'a bio on 2 of 10 pages is NOT site-wide');
  // The one-per-page body paragraphs are never site-wide.
  assert.ok(!report.fingerprints.includes(fingerprint('[H1] About Us')));
  assert.equal(report.blocks.some((b) => b.includes('planted in 1974')), false);
});

test('headings and consent paragraphs are never eligible', () => {
  assert.equal(eligible('[H1] Our Staff'), false);
  assert.equal(eligible('[H2#hours] Hours'), false);
  assert.equal(eligible('[SB][H3] Deacons'), false);
  assert.equal(eligible(CONSENT), false, 'LEO-132 owns consent text');
  assert.equal(eligible('Menu'), false, 'under the block-length floor');
  assert.equal(eligible(`[SB]${FOOTER}`), true);
});

test('a heading repeated on every page is still never called boilerplate', () => {
  const chrome = createChromeTracker({ baseUrl: 'https://gbc.test' });
  chrome.note(fixtureSite().map((p) => ({ url: p.url, text: ['[H1] Grace Baptist Church', p.text].join('\n\n') })));
  assert.ok(!chrome.report().fingerprints.includes(fingerprint('[H1] Grace Baptist Church')));
});

test('the pass does not engage on a site under the page floor', () => {
  const small = fixtureSite().slice(0, MIN_SITE_PAGES - 1);
  const chrome = createChromeTracker({ baseUrl: 'https://gbc.test' });
  chrome.note(small);
  const report = chrome.report();
  assert.equal(report.pageCount, MIN_SITE_PAGES - 1);
  assert.deepEqual(report.fingerprints, [], 'nothing is stripped on a tiny site');
});

test('the recomputed set drops a block the site stopped repeating', () => {
  const stale = fingerprint('A promo ribbon nobody renders any more on this website');
  const chrome = createChromeTracker({ known: [stale], baseUrl: 'https://gbc.test' });
  chrome.note(fixtureSite());
  assert.ok(chrome.known.has(stale), 'it is still stripped during THIS crawl');
  assert.ok(!chrome.report().fingerprints.includes(stale), 'and gone from the next crawl on');
});

test("the 'Site-wide info' chunk keeps the footer and omits the consent banner", async () => {
  const chrome = createChromeTracker({ baseUrl: 'https://gbc.test/', domain: 'gbc.test' });
  chrome.note(fixtureSite());

  const content = buildSiteWideContent(chrome.detected(), 'https://gbc.test/');
  assert.match(content, /\[H1\] Site-wide info/);
  assert.ok(content.includes(FOOTER), 'the service times and address survive');
  assert.ok(!content.includes('Accept all'), 'the consent banner is not promoted');
  // Info-bearing blocks are ranked first, so a cap can only drop the dross.
  assert.ok(content.indexOf(FOOTER) < content.indexOf(NAV));

  let asked = null;
  const chunk = await chrome.siteWideChunk(async (texts) => { asked = texts; return [[0.1, 0.2]]; });
  assert.equal(asked.length, 1, 'one embedding call, one chunk');
  assert.equal(chunk.url, 'https://gbc.test/#site-wide');
  assert.equal(chunk.url, siteWideUrlFor('https://gbc.test/anything?x=1'));
  assert.equal(chunk.label, 'Site-wide info');
  assert.deepEqual(chunk.embedding, [0.1, 0.2]);
  assert.deepEqual(chunk.sourceUrls, [chunk.url]);
});

test('no detected blocks means no chunk, and a missing embedder means no chunk', async () => {
  const empty = createChromeTracker({ baseUrl: 'https://gbc.test' });
  empty.note(fixtureSite().slice(0, 2));
  assert.equal(await empty.siteWideChunk(async () => [[0]]), null);

  const full = createChromeTracker({ baseUrl: 'https://gbc.test' });
  full.note(fixtureSite());
  assert.equal(await full.siteWideChunk(undefined), null);
  assert.equal(buildSiteWideContent([], 'https://gbc.test'), null);
});

test('isBoilerplate only fires for a known fingerprint of an eligible block', () => {
  const cs = { boilerplate: new Set([fingerprint(RECAPTCHA), fingerprint('[H1] Our Staff')]) };
  assert.equal(isBoilerplate(RECAPTCHA, cs), true);
  assert.equal(isBoilerplate(`[SB]${RECAPTCHA}  `, cs), true, 'markers and whitespace do not change the fingerprint');
  assert.equal(isBoilerplate('[H1] Our Staff', cs), false, 'a heading is exempt even if its hash was stored');
  assert.equal(isBoilerplate(FOOTER, cs), false);
  assert.equal(isBoilerplate(RECAPTCHA, {}), false, 'no set means strip nothing');
  assert.equal(isBoilerplate(RECAPTCHA, { boilerplate: new Set() }), false);
});

test('a known block is stripped from a normal page chunk but its content is not', () => {
  const text = ['[H1] Events', RECAPTCHA, 'The fall picnic is on the third Saturday of September at the pavilion behind the church.', `[SB]${FOOTER}`].join('\n\n');
  const cs = { boilerplate: new Set([fingerprint(RECAPTCHA), fingerprint(FOOTER)]) };

  const before = chunkText(text, 'https://gbc.test/events', {});
  assert.ok(before.map((c) => c.content).join('\n').includes('reCAPTCHA'));

  const after = chunkText(text, 'https://gbc.test/events', cs);
  const body = after.map((c) => c.content).join('\n');
  assert.ok(!body.includes('reCAPTCHA'), 'site-wide notice gone');
  assert.ok(!body.includes('717) 555-0142'), 'site-wide footer gone');
  assert.ok(body.includes('fall picnic'), 'the page\'s own content is untouched');
  assert.ok(body.includes('Events'), 'the heading is untouched');
});

test('a known block is stripped from thin-page cards too (they skip the old dedup)', () => {
  const thin = [
    { url: 'https://gbc.test/staff/kelly-robinson', text: ['[H1] Kelly Robinson', '[SB]Senior Pastor', '[SB]kelly@gbc.test', RECAPTCHA, `[SB]${FOOTER}`].join('\n\n') },
    { url: 'https://gbc.test/staff/dana-k', text: ['[H1] Dana K', '[SB]Office Manager', '[SB]dana@gbc.test', RECAPTCHA, `[SB]${FOOTER}`].join('\n\n') },
  ];
  const cs = { boilerplate: new Set([fingerprint(RECAPTCHA), fingerprint(FOOTER)]) };

  const before = buildGroupChunks('https://gbc.test/staff/', thin, {}).map((c) => c.content).join('\n');
  assert.equal((before.match(/reCAPTCHA/g) || []).length, 2, 'today: once per card');

  const after = buildGroupChunks('https://gbc.test/staff/', thin, cs).map((c) => c.content).join('\n');
  assert.ok(!after.includes('reCAPTCHA'));
  assert.ok(!after.includes('717) 555-0142'));
  assert.ok(after.includes('Kelly Robinson') && after.includes('kelly@gbc.test'), 'the card keeps its name and email');
  assert.ok(after.includes('Senior Pastor') && after.includes('Office Manager'));
});

test('cachedStructure reuses a stored Pass-1 answer and recomputes a stale one', async () => {
  let calls = 0;
  const compute = async () => { calls += 1; return { exclude: ['.fresh'], include: [] }; };

  const fresh = await cachedStructure(
    { pass1Exclude: ['.cached'], pass1Include: ['.main'], pass1At: new Date() }, compute);
  assert.deepEqual(fresh, { exclude: ['.cached'], include: ['.main'], cached: true });
  assert.equal(calls, 0, 'no Haiku call when the cache is warm');
  // A cache HIT must not re-stamp pass1At, or the 30-day expiry never arrives.
  assert.deepEqual(Object.keys(chromeUpdate({ pass1Filters: fresh })), []);

  const old = new Date(Date.now() - (PASS1_MAX_AGE_DAYS + 1) * 86_400_000);
  assert.deepEqual(await cachedStructure({ pass1Exclude: ['.cached'], pass1At: old }, compute), { exclude: ['.fresh'], include: [] });
  assert.equal(calls, 1, 'an expired cache is recomputed');

  assert.deepEqual(await cachedStructure(null, compute), { exclude: ['.fresh'], include: [] });
  assert.deepEqual(await cachedStructure({ pass1Exclude: [], pass1Include: [] }, compute), { exclude: ['.fresh'], include: [] });
  assert.equal(calls, 3);
});

test('chromeUpdate writes dotted keys and omits the half it was not given', () => {
  const both = chromeUpdate({ siteChrome: { fingerprints: ['a'], blocks: ['A'], pageCount: 9 }, pass1Filters: { exclude: ['.x'], include: [] } });
  assert.deepEqual(both['siteChrome.fingerprints'], ['a']);
  assert.deepEqual(both['siteChrome.blocks'], ['A']);
  assert.equal(both['siteChrome.pageCount'], 9);
  assert.deepEqual(both['siteChrome.pass1Exclude'], ['.x']);
  assert.ok(both['siteChrome.at'] instanceof Date && both['siteChrome.pass1At'] instanceof Date);

  // A crawl whose Pass 1 found nothing must not blank the stored selectors.
  const chromeOnly = chromeUpdate({ siteChrome: { fingerprints: [], blocks: [], pageCount: 2 }, pass1Filters: { exclude: [], include: [] } });
  assert.deepEqual(Object.keys(chromeOnly).sort(), ['siteChrome.at', 'siteChrome.blocks', 'siteChrome.fingerprints', 'siteChrome.pageCount']);
  assert.deepEqual(chromeUpdate({}), {});
  assert.deepEqual(chromeUpdate({ pass1Filters: { exclude: ['.y'] } })['siteChrome.pass1Exclude'], ['.y']);
});
