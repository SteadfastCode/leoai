// Short schedule lines (LEO-143).
//
// Two layers of test:
//   1. The helper in isolation — joining rules, the chrome gate, the dedup cap.
//   2. The real cheerio extraction + chunkText pipeline over fixtures trimmed
//      from the page that exposed the bug (campcalvary.com/camps/mr/) and a
//      chrome fixture whose boilerplate sits outside <nav>/<footer>.
//
// No DB, no network, no browser. The extraction wrapper below repeats the three
// whitespace normalizations fetchPage applies between extractStructuredText and
// chunkText — fetchPage itself is not exported, and chunking against un-
// normalized text would not be the text the scraper actually chunks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');

const { toParagraphs, isScheduleLine, MAX_JOIN_LEN } = require('../src/services/scheduleLines');
const { chunkText, extractStructuredText } = require('../src/services/scraper');

const URL = 'https://campcalvary.com/camps/mr/';

function textFromFixture(name) {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'chunking', name), 'utf8');
  const $ = cheerio.load(html);
  $('nav, footer, script, style, noscript').remove();
  return extractStructuredText($, $('body')[0])
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------- helper unit

test('isScheduleLine keeps clock times, meridiem times, weekdays, dates and prices', () => {
  for (const line of [
    '7:00 Dinner', '8:15 SESSION #1', '10:00 Break', '12:15 pm Lunch',
    '7 pm', '10:45 A.M.', 'Sunday', 'Fri', 'Weekends', 'March', 'Dec 6',
    '3/14', '3/14/2026', '$95', 'Closed Sundays',
  ]) {
    assert.equal(isScheduleLine(line), true, `expected kept: ${line}`);
  }
});

test('isScheduleLine ignores chrome words', () => {
  for (const line of ['Home', 'About', 'Contact', 'Shop', 'Cart', 'Share', 'Tweet', 'Top', 'Menu', 'Read more']) {
    assert.equal(isScheduleLine(line), false, `expected ignored: ${line}`);
  }
});

test('isScheduleLine looks past [SB] and heading markers', () => {
  assert.equal(isScheduleLine('[SB]7:00 Dinner'), true);
  assert.equal(isScheduleLine('[H2#sched] Friday'), true);
  assert.equal(isScheduleLine('[SB]Home'), false);
});

test('a run of short lines carrying a time becomes one paragraph, one line each', () => {
  const paras = toParagraphs('[SB]7:00 Dinner\n8:15 SESSION #1\n10:00 Break');
  assert.deepEqual(paras, ['[SB]7:00 Dinner\n8:15 SESSION #1\n10:00 Break']);
});

test('blank-line block boundaries still separate paragraphs', () => {
  assert.deepEqual(
    toParagraphs('7:00 Dinner\n8:15 SESSION #1\n\nSaturday\n8:00 Breakfast'),
    ['7:00 Dinner\n8:15 SESSION #1', 'Saturday\n8:00 Breakfast'],
  );
});

test('a run with no schedule signal is left as separate lines, exactly as the old split', () => {
  const block = 'Home\nAbout\nContact\nShop\nCart';
  assert.deepEqual(toParagraphs(block), ['Home', 'About', 'Contact', 'Shop', 'Cart']);
  // ...which is what text.split(/\n+/) produced before this item.
  assert.deepEqual(toParagraphs(block), block.split(/\n+/));
});

test('a lone short line is never joined to its neighbours', () => {
  assert.deepEqual(
    toParagraphs('A long line of ordinary prose that runs well past sixty characters in total.\n7:00 Dinner\nAnother long line of ordinary prose that also runs past sixty characters.'),
    [
      'A long line of ordinary prose that runs well past sixty characters in total.',
      '7:00 Dinner',
      'Another long line of ordinary prose that also runs past sixty characters.',
    ],
  );
});

test('headings are never folded into a run', () => {
  assert.deepEqual(
    toParagraphs('[H2#sched] Friday\n7:00 Dinner\n8:15 SESSION #1'),
    ['[H2#sched] Friday', '7:00 Dinner\n8:15 SESSION #1'],
  );
});

test('a joined paragraph never exceeds the cross-page dedup cap', () => {
  // A whole week of day/time lines in one <br> run, long enough in total to
  // pass the cap. Each joined paragraph must stay under MAX_JOIN_LEN or it
  // would bypass seenParaHashes and re-emit on every page of the site.
  const week = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    .map((d) => `${d} 9:00 am - 5:00 pm (kitchen closes 4)`).join('\n');
  assert.ok(week.length > MAX_JOIN_LEN, 'fixture must exceed the cap to test it');
  const paras = toParagraphs(week);
  assert.ok(paras.length > 1, 'expected the run to be split by the cap');
  for (const p of paras) assert.ok(p.length <= MAX_JOIN_LEN, `paragraph over cap: ${p.length}`);
  // No line is lost to the cap.
  assert.deepEqual(paras.flatMap((p) => p.split('\n')), week.split('\n'));
});

test('empty and whitespace-only text yield no paragraphs', () => {
  assert.deepEqual(toParagraphs(''), []);
  assert.deepEqual(toParagraphs('\n\n  \n'), []);
  assert.deepEqual(toParagraphs(null), []);
});

// ------------------------------------------------------- real-page regression

test("campcalvary Men's Retreat: every short schedule line survives chunking", () => {
  const chunks = chunkText(textFromFixture('schedule-lines.html'), URL);
  const all = chunks.map((c) => c.content).join('\n---\n');

  // The seven lines the live page lost before this item.
  for (const line of [
    '7:00 Dinner',
    '8:15 SESSION #1',
    '8:45 SESSION #2',
    '10:00 Break',
    '11:00 SESSION #3',
    '3:45 SESSION #4',
    '5:00 Dinner',
  ]) {
    assert.ok(all.includes(line), `missing schedule line: ${line}`);
  }

  // ...and the lines that always survived are still there, in order.
  assert.ok(all.includes('1:00 Free Time Activities'));
  assert.ok(all.indexOf('8:15 SESSION #1') < all.indexOf('8:45 SESSION #2'));
  assert.ok(all.indexOf('8:45 SESSION #2') < all.indexOf('3:45 SESSION #4'));
});

test("campcalvary Men's Retreat: Friday's schedule stays one unit in one chunk", () => {
  const chunks = chunkText(textFromFixture('schedule-lines.html'), URL);
  const friday = chunks.find((c) => c.content.includes('7:00 Dinner'));
  assert.ok(friday, 'expected a chunk holding the Friday schedule');
  // One paragraph, one line each — consecutive lines, no blank line between.
  assert.match(friday.content, /7:00 Dinner\n8:00 Welcome and Introductions\n8:15 SESSION #1/);
});

test("campcalvary Men's Retreat: the page's own chrome is still excluded", () => {
  const chunks = chunkText(textFromFixture('schedule-lines.html'), URL);
  const all = chunks.map((c) => c.content).join('\n---\n');
  // Nav/footer removal is unchanged, and the mobile menu's short div lines
  // (separate blocks, no schedule signal) still fall to the 20-char floor.
  for (const chrome of ['Privacy', 'Terms', 'Share', 'Top']) {
    assert.ok(!all.includes(chrome), `chrome leaked into chunks: ${chrome}`);
  }
});

test('chrome outside nav/footer: short <br> runs with no schedule signal are still dropped', () => {
  const chunks = chunkText(textFromFixture('schedule-chrome.html'), 'https://example.com/banquet/');
  const all = chunks.map((c) => c.content).join('\n---\n');

  // A <br>-separated utility menu and a row of share affordances: both runs of
  // short lines in one block, neither carrying a schedule signal, so neither is
  // joined and every line stays below keepPara's 20-char floor.
  for (const chrome of ['About', 'Contact', 'Shop', 'Cart', 'Share', 'Tweet', 'Pin', 'Top']) {
    assert.ok(!all.includes(chrome), `chrome leaked into chunks: ${chrome}`);
  }

  // "Home" is the one line that survives, and it survived before this item too:
  // the <p> wrapper marks the whole widget [SB], the marker lands on the FIRST
  // line after the paragraph split, and [SB] carries a 4-char floor. Verified
  // identical against HEAD~ output. Unchanged here, and deliberately not fixed
  // by this item — the marker's placement is a separate scraper concern.
  assert.ok(all.includes('Home'));

  // The real schedule on the same page is kept, as one unit.
  assert.match(all, /Fri 6:00 Doors Open\n6:30 Dinner\n7:15 Program/);
});
